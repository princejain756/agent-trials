// Self-check: runs the compiled CLI against stub agents in a fixture repo.
// No real agent CLIs needed. Run: npm run build && node test/run.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const cli = path.join(repo, "dist", "cli.js");
assert.ok(existsSync(cli), "dist/cli.js missing - run npm run build first");

const work = mkdtempSync(path.join(tmpdir(), "agent-trials-test-"));
// Point the CLI's temp output at a directory of our own so the kept-copy
// assertions can never pick up leftovers from an earlier or failed run.
const sandboxRoot = path.join(work, "sandbox");
mkdirSync(sandboxRoot, { recursive: true });
const cliEnv = { ...process.env, TMPDIR: sandboxRoot };
const fixture = path.join(work, "fixture");
mkdirSync(fixture, { recursive: true });
writeFileSync(path.join(fixture, "answer.txt"), "wrong\n");
writeFileSync(path.join(fixture, "package.json"), '{"name":"fixture"}\n');
mkdirSync(path.join(fixture, "node_modules", "junk"), { recursive: true });
writeFileSync(path.join(fixture, "node_modules", "junk", "big.bin"), "x".repeat(1024));
mkdirSync(path.join(fixture, "verify"));
writeFileSync(path.join(fixture, "verify", "check.sh"), "#!/bin/sh\ngrep -q right answer.txt\n");

// A secret-looking file in the repo root: must never reach the working copy.
writeFileSync(path.join(fixture, ".env"), "ANTHROPIC_API_KEY=sk-fixture-should-not-be-copied\n");

const stubs = path.join(work, "stubs");
mkdirSync(stubs);
writeFileSync(
  path.join(stubs, "ok.sh"),
  '#!/bin/sh\nprintf "right\\n" > answer.txt\necho "{\\"total_cost_usd\\":0.01,\\"modelUsage\\":{\\"stub-model-1\\":{}}}"\n',
);
writeFileSync(path.join(stubs, "lazy.sh"), "#!/bin/sh\nexit 0\n");
writeFileSync(
  path.join(stubs, "cheat.sh"),
  '#!/bin/sh\nprintf "#!/bin/sh\\nexit 0\\n" > verify/check.sh\n',
);
// Records whether parent-only env vars leak into the child.
writeFileSync(
  path.join(stubs, "envcheck.sh"),
  '#!/bin/sh\nprintf "%s" "$AGENT_TRIALS_LEAK_CANARY" > leaked.txt\nprintf "right\\n" > answer.txt\n',
);
// Records whether a secret file survived into the working copy.
writeFileSync(
  path.join(stubs, "secretcheck.sh"),
  '#!/bin/sh\nif [ -f .env ]; then printf "leaked" > secret-leak.txt; fi\nprintf "right\\n" > answer.txt\n',
);

const suite = {
  name: "self-check",
  timeoutSec: 30,
  tasks: [
    { id: "t1", prompt: "fix the file", verify: "sh verify/check.sh" },
    { id: "t2", prompt: "fix again", verify: "sh verify/check.sh" },
  ],
  agents: {
    "ok-agent": { run: ["sh", path.join(stubs, "ok.sh"), "{prompt}"], resultJson: true },
    "lazy-agent": { run: ["sh", path.join(stubs, "lazy.sh"), "{prompt}"] },
    "cheat-agent": { run: ["sh", path.join(stubs, "cheat.sh"), "{prompt}"] },
  },
};
const suiteFile = path.join(work, "trials.json");
writeFileSync(suiteFile, JSON.stringify(suite));

const outMd = path.join(work, "TRIALS.md");
const outJson = path.join(work, "results.json");
process.env.AGENT_TRIALS_LEAK_CANARY = "should-not-be-visible";
const stdout = execFileSync(
  process.execPath,
  [cli, "run", "--suite", suiteFile, "--root", fixture, "--agents", "ok-agent,lazy-agent,cheat-agent", "--out", outMd, "--json", outJson],
  { encoding: "utf-8", timeout: 60_000, env: cliEnv },
);

assert.match(stdout, /\[pass\] ok-agent · t1/, "ok-agent should pass t1");
assert.match(stdout, /\[fail\] lazy-agent · t1/, "lazy-agent should fail t1");
assert.match(stdout, /\[fail\] cheat-agent · t1/, "tampered checker should still fail");
assert.match(stdout, /score\s+2\/2\s+0\/2\s+0\/2/, "scoreboard counts wrong");
assert.match(stdout, /winner: ok-agent/, "wrong winner");

const cells = JSON.parse(readFileSync(outJson, "utf-8"));
assert.equal(
  cells.find((c) => c.agent === "ok-agent" && c.task === "t1").modelUsed,
  "stub-model-1",
  "model identity not captured",
);
assert.ok(
  cells.every((c) => Array.isArray(c.verifyRestored) && c.verifyRestored.includes("verify")),
  "verify/ restore not recorded",
);

assert.equal(
  readFileSync(path.join(fixture, "answer.txt"), "utf-8"),
  "wrong\n",
  "sandbox leaked: fixture was modified",
);
assert.ok(existsSync(outMd), "TRIALS.md not written");
const md = readFileSync(outMd, "utf-8");
assert.match(md, /\| t1 \|/, "markdown missing task row");
assert.match(md, /\*\*2\/2\*\*/, "markdown missing score");

const { median, renderBoard } = await import(path.join(repo, "dist", "trials.js"));
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 2]), 3);
assert.ok(renderBoard(suite, [], ["a"]).includes("agent-trials"));

// --- security posture -------------------------------------------------------

// Parent env must not reach the agent. The stub writes the canary to leaked.txt
// if it is visible; the file must not exist in the kept working copy.
const secSuite = {
  name: "security",
  timeoutSec: 30,
  tasks: [{ id: "s1", prompt: "go", verify: "sh verify/check.sh" }],
  agents: {
    "env-agent": { run: ["sh", path.join(stubs, "envcheck.sh"), "{prompt}"] },
    "secret-agent": { run: ["sh", path.join(stubs, "secretcheck.sh"), "{prompt}"] },
  },
};
const secSuiteFile = path.join(work, "trials-sec.json");
writeFileSync(secSuiteFile, JSON.stringify(secSuite));
const secRoot = path.join(work, "fixture-sec");
cpSync(fixture, secRoot, { recursive: true });
rmSync(path.join(secRoot, "verify", "check.sh"));
writeFileSync(path.join(secRoot, "verify", "check.sh"), "#!/bin/sh\nexit 0\n");

const secStdout = execFileSync(
  process.execPath,
  [cli, "run", "--suite", secSuiteFile, "--root", secRoot, "--agents", "env-agent,secret-agent", "--out", "none", "--keep"],
  { encoding: "utf-8", timeout: 60_000, env: cliEnv },
);
assert.match(secStdout, /var\(s\) withheld from agents/, "no env withholding reported");
assert.match(secStdout, /matching file\(s\) skipped/, "secret skip not reported");

const kept = readdirSync(sandboxRoot).filter((d) => d.startsWith("agent-trials-s1-"));
assert.ok(kept.length > 0, "no kept working copies to inspect");
for (const dir of kept) {
  const base = path.join(sandboxRoot, dir);
  assert.ok(!existsSync(path.join(base, ".env")), `.env leaked into kept copy ${dir}`);
  const leakFile = path.join(base, "leaked.txt");
  if (existsSync(leakFile)) {
    assert.equal(
      readFileSync(leakFile, "utf-8"),
      "",
      `parent env leaked into ${dir}`,
    );
  }
  rmSync(base, { recursive: true, force: true });
}

// A repo containing a secret file must skip it silently and still run.
const blocked = spawnSync(
  process.execPath,
  [cli, "run", "--suite", suiteFile, "--root", fixture, "--agents", "ok-agent", "--out", "none"],
  { encoding: "utf-8", timeout: 60_000, env: cliEnv },
);
assert.equal(blocked.status, 0, "secret file should be skipped, not abort: " + blocked.stderr);
assert.match(blocked.stdout, /matching file\(s\) skipped/, "secret skip not surfaced to user");

// Builtin agents require --unsafe.
const builtinBlocked = spawnSync(process.execPath, [cli, "run", "--suite", suiteFile, "--agents", "claude"], {
  encoding: "utf-8",
  timeout: 60_000,
  env: cliEnv,
});
assert.notEqual(builtinBlocked.status, 0, "builtin agent ran without --unsafe");
assert.match(builtinBlocked.stderr, /--unsafe/, "missing --unsafe guidance");

// --- secret classification --------------------------------------------------

const { findSecrets, isSecretPath, copyWorkdir, pickModel: pickModelOf } = await import(
  path.join(repo, "dist", "trials.js")
);

// These must be treated as secrets.
for (const name of [".env", ".env.local", ".env.production", ".npmrc", ".netrc", "id_rsa", "server.pem", "client.key", "app.p12", ".htpasswd"]) {
  assert.ok(isSecretPath(name), `${name} should be a secret`);
}
// These must not. config.json previously matched a bare-filename pattern and
// was silently deleted from every working copy, which broke agent runs on any
// repo that had one.
for (const name of ["config.json", "src/config.json", "credentials.js", "package.json", ".env.example", ".env.sample", "id_rsa.pub", "readme.md", "keys.ts"]) {
  assert.ok(!isSecretPath(name), `${name} must NOT be treated as a secret`);
}
// A bare `credentials` or `config` is only secret inside a credential dir.
assert.ok(isSecretPath("credentials", ".aws"), ".aws/credentials should be a secret");
assert.ok(isSecretPath("config", ".ssh"), ".ssh/config should be a secret");
assert.ok(!isSecretPath("credentials", "src"), "src/credentials must not be a secret");

const secretFixture = path.join(work, "secret-fixture");
mkdirSync(path.join(secretFixture, "src"), { recursive: true });
mkdirSync(path.join(secretFixture, ".aws"), { recursive: true });
mkdirSync(path.join(secretFixture, ".ssh"), { recursive: true });
writeFileSync(path.join(secretFixture, "config.json"), "{}\n");
writeFileSync(path.join(secretFixture, "src", "config.json"), "{}\n");
writeFileSync(path.join(secretFixture, "src", "index.js"), "export const x=1\n");
writeFileSync(path.join(secretFixture, "src", "credentials.js"), "// source\n");
writeFileSync(path.join(secretFixture, ".env.example"), "KEY=your-key\n");
writeFileSync(path.join(secretFixture, "id_rsa.pub"), "ssh-rsa AAAA\n");
writeFileSync(path.join(secretFixture, ".env"), "KEY=real\n");
writeFileSync(path.join(secretFixture, "id_rsa"), "PRIVATE\n");
writeFileSync(path.join(secretFixture, "server.pem"), "PEM\n");
writeFileSync(path.join(secretFixture, ".aws", "credentials"), "aws\n");

const reported = findSecrets(secretFixture);
for (const mustDrop of [".env", "id_rsa", "server.pem"]) {
  assert.ok(reported.includes(mustDrop), `${mustDrop} not reported as a secret`);
}
for (const mustKeep of ["config.json", "src/config.json", ".env.example", "id_rsa.pub"]) {
  assert.ok(!reported.some((r) => r.endsWith(mustKeep)), `${mustKeep} wrongly reported as a secret`);
}

const secretCopy = path.join(work, "secret-copy");
copyWorkdir(secretFixture, secretCopy);
for (const kept of ["config.json", "src/config.json", "src/index.js", "src/credentials.js", ".env.example", "id_rsa.pub"]) {
  assert.ok(existsSync(path.join(secretCopy, kept)), `${kept} was wrongly dropped from the working copy`);
}
for (const dropped of [".env", "id_rsa", "server.pem", ".aws"]) {
  assert.ok(!existsSync(path.join(secretCopy, dropped)), `${dropped} leaked into the working copy`);
}

// --- model identity ---------------------------------------------------------

// modelUsage key order is not meaningful; a single explicit model field wins.
assert.equal(
  pickModelOf({ model: "claude-opus-5", modelUsage: { haiku: {}, opus: {} } }),
  "claude-opus-5",
  "explicit model field should win over usage map order",
);
assert.equal(
  pickModelOf({ modelUsage: { "gpt-6": {} } }),
  "gpt-6",
  "single-entry usage map should be reported",
);
assert.equal(
  pickModelOf({ modelUsage: { small: { output_tokens: 10 }, big: { output_tokens: 900 } } }),
  "big",
  "with several models, the one doing the most work should be reported",
);
assert.equal(pickModelOf({}), undefined, "no model info should yield undefined");

// --- verify restore must not leave agent-added files behind -----------------

// An agent that drops an extra file into a protected verify dir must not have
// it survive the restore, because the verify command can then execute it.
const addSuite = {
  name: "restore",
  timeoutSec: 30,
  tasks: [{ id: "r1", prompt: "go", verify: "sh verify/check.sh" }],
  agents: {
    "adder-agent": {
      run: [
        "sh",
        "-c",
        "printf '#!/bin/sh\\necho TAMPERED\\nexit 0\\n' > verify/check.sh; printf 'agent was here\\n' > verify/agent-added.sh; exit 0",
      ],
    },
  },
};
const addSuiteFile = path.join(work, "trials-restore.json");
writeFileSync(addSuiteFile, JSON.stringify(addSuite));
const addRoot = path.join(work, "fixture-restore");
mkdirSync(path.join(addRoot, "verify"), { recursive: true });
// The real checker fails on purpose, so a tampered checker would look like a pass.
writeFileSync(path.join(addRoot, "verify", "check.sh"), "#!/bin/sh\necho REAL CHECKER RAN\nexit 0\n");
writeFileSync(path.join(addRoot, "answer.txt"), "wrong\n");

const addOut = execFileSync(
  process.execPath,
  [cli, "run", "--suite", addSuiteFile, "--root", addRoot, "--agents", "adder-agent", "--out", "none", "--keep"],
  { encoding: "utf-8", timeout: 60_000, env: cliEnv },
);
const keptRestore = readdirSync(sandboxRoot).filter((d) => d.startsWith("agent-trials-r1-"));
assert.ok(keptRestore.length > 0, "no kept copy to inspect for restore test");
for (const dir of keptRestore) {
  const base = path.join(sandboxRoot, dir);
  const checker = readFileSync(path.join(base, "verify", "check.sh"), "utf-8");
  assert.match(checker, /REAL CHECKER RAN/, `tampered checker survived restore in ${dir}`);
  assert.ok(
    !existsSync(path.join(base, "verify", "agent-added.sh")),
    `agent-added file survived restore in ${dir} and could run during verify`,
  );
  rmSync(base, { recursive: true, force: true });
}

// --- the --unsafe gate must not be reachable by redefining a builtin --------

// A suite that ships its own "claude" agent with bypass flags used to run with
// no gate at all, because only the builtin spec carried the unsafe marker.
const bypassSuite = {
  name: "bypass",
  timeoutSec: 30,
  tasks: [{ id: "b1", prompt: "go", verify: "sh -c 'exit 0'" }],
  agents: {
    claude: { run: ["claude", "-p", "{prompt}", "--dangerously-skip-permissions"] },
    sneaky: { run: ["sh", "-c", "true", "some-agent", "--yolo"] },
    harmless: { run: ["sh", "-c", "true"] },
  },
};
const bypassFile = path.join(work, "trials-bypass.json");
writeFileSync(bypassFile, JSON.stringify(bypassSuite));

const bypassAttempt = spawnSync(
  process.execPath,
  [cli, "run", "--suite", bypassFile, "--agents", "claude", "--root", fixture, "--out", "none"],
  { encoding: "utf-8", timeout: 60_000, env: cliEnv },
);
assert.notEqual(bypassAttempt.status, 0, "redefined builtin bypassed the --unsafe gate");
assert.match(bypassAttempt.stderr, /--unsafe/, "bypass refusal should mention --unsafe");

const sneakyAttempt = spawnSync(
  process.execPath,
  [cli, "run", "--suite", bypassFile, "--agents", "sneaky", "--root", fixture, "--out", "none"],
  { encoding: "utf-8", timeout: 60_000, env: cliEnv },
);
assert.notEqual(sneakyAttempt.status, 0, "custom agent with bypass flag ran without --unsafe");

// A genuinely safe custom agent must still run without the flag.
const safeRun = spawnSync(
  process.execPath,
  [cli, "run", "--suite", bypassFile, "--agents", "harmless", "--root", fixture, "--out", "none"],
  { encoding: "utf-8", timeout: 60_000, env: cliEnv },
);
assert.equal(safeRun.status, 0, "safe custom agent should not require --unsafe: " + safeRun.stderr);

const { resolveAgents, loadSuite } = await import(path.join(repo, "dist", "trials.js"));
const resolved = resolveAgents(undefined, bypassSuite);
assert.equal(resolved.claude.unsafe, true, "redefined builtin should inherit unsafe");
assert.equal(resolved.sneaky.unsafe, true, "argv containing --yolo should mark the agent unsafe");
assert.notEqual(resolved.harmless.unsafe, true, "plain sh agent should not be unsafe");

// --- suite validation -------------------------------------------------------

const badSuites = [
  [{ tasks: [{ id: "t1", prompt: "p", verify: "true" }, { id: "t1", prompt: "p2", verify: "true" }] }, /duplicate task id/],
  [{ tasks: [{ id: "../escape", prompt: "p", verify: "true" }] }, /path separator/],
  [{ tasks: [{ id: "a/b", prompt: "p", verify: "true" }] }, /path separator/],
  [{ timeoutSec: 0, tasks: [{ id: "t1", prompt: "p", verify: "true" }] }, /positive number/],
  [{ timeoutSec: -5, tasks: [{ id: "t1", prompt: "p", verify: "true" }] }, /positive number/],
  [{ timeoutSec: "soon", tasks: [{ id: "t1", prompt: "p", verify: "true" }] }, /positive number/],
  [{ allowedEnv: "PATH", tasks: [{ id: "t1", prompt: "p", verify: "true" }] }, /allowedEnv/],
];
for (const [suiteBody, pattern] of badSuites) {
  const f = path.join(work, `bad-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(suiteBody));
  assert.throws(() => loadSuite(f), pattern, `should reject ${JSON.stringify(suiteBody).slice(0, 60)}`);
}

// --- job count validation ---------------------------------------------------

const badJobs = spawnSync(
  process.execPath,
  [cli, "run", "--suite", suiteFile, "--agents", "ok-agent", "--root", fixture, "--jobs", "abc", "--out", "none"],
  { encoding: "utf-8", timeout: 60_000, env: cliEnv },
);
assert.notEqual(badJobs.status, 0, "--jobs abc should be rejected");

const hugeJobs = spawnSync(
  process.execPath,
  [cli, "run", "--suite", suiteFile, "--agents", "ok-agent", "--root", fixture, "--jobs", "100000", "--out", "none"],
  { encoding: "utf-8", timeout: 60_000, env: cliEnv },
);
assert.notEqual(hugeJobs.status, 0, "absurd --jobs should be rejected");

// --- deterministic --json ordering ------------------------------------------

const orderA = path.join(work, "order-a.json");
const orderB = path.join(work, "order-b.json");
const orderArgs = [
  cli, "run", "--suite", suiteFile, "--root", fixture,
  "--agents", "ok-agent,lazy-agent,cheat-agent", "--out", "none", "--json",
];
execFileSync(process.execPath, [...orderArgs, orderA], { encoding: "utf-8", timeout: 60_000, env: cliEnv });
execFileSync(process.execPath, [...orderArgs, orderB], { encoding: "utf-8", timeout: 60_000, env: cliEnv });
const a = JSON.parse(readFileSync(orderA, "utf-8"));
const b = JSON.parse(readFileSync(orderB, "utf-8"));
const key = (c) => `${c.agent}/${c.task}`;
assert.deepEqual(a.map(key), b.map(key), "--json cell order differs between identical runs");

// --- symlinks must not carry a path out of the repo -------------------------

const linkRoot = path.join(work, "link-fixture");
const outside = path.join(work, "outside");
mkdirSync(linkRoot, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE FILE\n");
writeFileSync(path.join(linkRoot, "app.js"), "export const a=1\n");
symlinkSync(path.join(outside, "secret.txt"), path.join(linkRoot, "innocent.txt"));
symlinkSync(outside, path.join(linkRoot, "linked-dir"));

const linkCopy = path.join(work, "link-copy");
copyWorkdir(linkRoot, linkCopy);
assert.ok(existsSync(path.join(linkCopy, "app.js")), "ordinary file missing from symlink copy");
const copiedTargets = [];
for (const entry of readdirSync(linkCopy, { withFileTypes: true })) {
  if (entry.isSymbolicLink()) copiedTargets.push(entry.name);
}
assert.deepEqual(copiedTargets, [], "symlinks were preserved into the working copy");
assert.ok(!existsSync(path.join(linkCopy, "linked-dir")), "symlinked dir leaked its target into the copy");

rmSync(work, { recursive: true, force: true });
console.log("agent-trials self-check passed");
