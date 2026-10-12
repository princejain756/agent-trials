// Self-check: runs the compiled CLI against stub agents in a fixture repo.
// No real agent CLIs needed. Run: npm run build && node test/run.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const cli = path.join(repo, "dist", "cli.js");
assert.ok(existsSync(cli), "dist/cli.js missing - run npm run build first");

const work = mkdtempSync(path.join(tmpdir(), "agent-trials-test-"));
const fixture = path.join(work, "fixture");
mkdirSync(fixture, { recursive: true });
writeFileSync(path.join(fixture, "answer.txt"), "wrong\n");
writeFileSync(path.join(fixture, "package.json"), '{"name":"fixture"}\n');
mkdirSync(path.join(fixture, "node_modules", "junk"), { recursive: true });
writeFileSync(path.join(fixture, "node_modules", "junk", "big.bin"), "x".repeat(1024));
mkdirSync(path.join(fixture, "verify"));
writeFileSync(path.join(fixture, "verify", "check.sh"), "#!/bin/sh\ngrep -q right answer.txt\n");

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
const stdout = execFileSync(
  process.execPath,
  [cli, "run", "--suite", suiteFile, "--root", fixture, "--agents", "ok-agent,lazy-agent,cheat-agent", "--out", outMd, "--json", outJson],
  { encoding: "utf-8", timeout: 60_000 },
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

rmSync(work, { recursive: true, force: true });
console.log("agent-trials self-check passed");
