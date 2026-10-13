#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  agentInstalled,
  BUILTIN_AGENTS,
  buildEnv,
  findSecrets,
  findSymlinks,
  loadSuite,
  renderBoard,
  renderMarkdown,
  resolveAgents,
  runSuite,
  writeMarkdown,
  verdictOf,
  type Cell,
  type Suite,
} from "./trials.js";

const VERSION = "1.1.0";

const HELP = `agent-trials ${VERSION}
Interview your coding agent before you ship with it.

usage:
  agent-trials init                 write a starter trials.json
  agent-trials doctor               check which agent CLIs are installed
  agent-trials run                  run the suite and print the scoreboard

run flags:
  --suite <file>    suite file (default: trials.json)
  --agents a,b      only these agents (default: all known + custom)
  --root <dir>      repo to run on (default: cwd)
  --jobs <n>        parallel cells (default: 2)
  --out <file>      markdown report path (default: TRIALS.md, "none" skips)
  --json <file>     also write raw results JSON
  --keep            keep working copies for debugging
  --unsafe          allow builtin agents to run with approval prompts disabled
  --allow-secrets   copy secret-looking files (.env, *.pem, id_*) into the workdir
`;

const STARTER_SUITE = {
  name: "my repo trials",
  setup: "",
  verify: "npm test",
  timeoutSec: 600,
  tasks: [
    {
      id: "example-task",
      prompt: "Describe what this repo does in one sentence, then make the smallest possible improvement to the README.",
      verify: "git diff --quiet || true",
    },
  ],
  agents: {},
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out[key] = argv[++i];
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(`agent-trials: ${msg}`);
  process.exit(1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);

  if (!cmd || flags.help || cmd === "help") {
    console.log(HELP);
    return;
  }
  if (cmd === "--version" || cmd === "-v" || flags.version) {
    console.log(VERSION);
    return;
  }

  if (cmd === "init") {
    const file = typeof flags.suite === "string" ? flags.suite : "trials.json";
    if (existsSync(file) && !flags.force) {
      fail(`${file} already exists (use --force to overwrite)`);
    }
    writeFileSync(file, JSON.stringify(STARTER_SUITE, null, 2) + "\n");
    console.log(
      `wrote ${file}\n\nedit tasks[] with real work for your repo, then:\n  agent-trials run`,
    );
    return;
  }

  if (cmd === "doctor") {
    const suiteFile = typeof flags.suite === "string" ? flags.suite : "trials.json";
    const suite: Suite = existsSync(suiteFile)
      ? loadSuite(suiteFile)
      : { tasks: [] };
    const agents = resolveAgents(
      typeof flags.agents === "string" ? flags.agents.split(",") : undefined,
      suite,
    );
    console.log("agent-trials doctor\n");
    for (const [name, spec] of Object.entries(agents)) {
      const bin = spec.argv[0];
      const ok = agentInstalled(bin);
      const src = BUILTIN_AGENTS[name] ? "builtin" : "custom";
      console.log(`${ok ? "ok  " : "miss"} ${name.padEnd(10)} ${bin}${ok ? "" : "  (not on PATH)"}  [${src}]`);
    }
    console.log("\nmissing agents are skipped at run time only if you pass --agents");
    return;
  }

  if (cmd === "run") {
    const suiteFile = typeof flags.suite === "string" ? flags.suite : "trials.json";
    if (!existsSync(suiteFile)) {
      fail(`no ${suiteFile}. run \`agent-trials init\` or pass --suite <file>`);
    }
    const suite = loadSuite(suiteFile);
    const root = path.resolve(typeof flags.root === "string" ? flags.root : ".");
    const agentNames =
      typeof flags.agents === "string" ? flags.agents.split(",") : undefined;
    let agents = resolveAgents(agentNames, suite);

    const missing = Object.entries(agents)
      .filter(([, s]) => !agentInstalled(s.argv[0]))
      .map(([n]) => n);
    if (missing.length && !agentNames) {
      for (const n of missing) delete agents[n];
      console.log(`skipping missing agents: ${missing.join(", ")}`);
    }
    const names = Object.keys(agents);
    if (names.length === 0) fail("no agents available. install claude/codex/gemini or define a custom agent");

    const unsafeAgents = names.filter((n) => agents[n].unsafe);
    if (unsafeAgents.length && !flags.unsafe) {
      fail(
        `these agents run with approval prompts disabled: ${unsafeAgents.join(", ")}\n` +
          `  they can read and write anything your user can, inside the working copy or outside it.\n` +
          `  pass --unsafe to accept that, or define a custom agent with your own flags.`,
      );
    }

    const jobsFlag = flags.jobs;
    let jobs = 2;
    if (jobsFlag !== undefined) {
      const n = Number(jobsFlag);
      if (!Number.isInteger(n) || n < 1) {
        fail(`--jobs needs a whole number of 1 or more, got "${jobsFlag}"`);
      }
      if (n > 32) {
        fail(`--jobs ${n} is too many; each cell copies the whole repo, so cap it at 32`);
      }
      jobs = n;
    }
    const keep = Boolean(flags.keep);
    const started = Date.now();
    const { withheld } = buildEnv(suite.allowedEnv);
    const secrets = findSecrets(root);
    console.log(
      `env: ${withheld.length} var(s) withheld from agents and verify commands` +
        (suite.allowedEnv?.length ? ` (suite allows ${suite.allowedEnv.join(", ")})` : ""),
    );
    if (secrets.length) {
      console.log(
        `secrets: ${secrets.length} matching file(s) skipped from the working copy -> ${secrets.join(", ")}`,
      );
    }
    const links = findSymlinks(root);
    if (links.length) {
      console.log(
        `symlinks: ${links.length} skipped (not copied, so the agent cannot follow them out of the repo)` +
          (links.length <= 5 ? ` -> ${links.join(", ")}` : ""),
      );
    }
    const results = await runSuite({
      root,
      suite,
      agents,
      jobs,
      keep,
      allowSecrets: Boolean(flags["allow-secrets"]),
      onCell: (c: Cell) => {
        const verdict = verdictOf(c);
        console.log(`  [${verdict}] ${c.agent} · ${c.task} · ${c.sec}s`);
      },
    });
    console.log("");
    const board = renderBoard(suite, results, names);
    console.log(board);
    console.log(`\ntotal wall time ${Math.round((Date.now() - started) / 1000)}s`);
    const out = flags.out === undefined ? "TRIALS.md" : flags.out;
    if (out !== "none" && typeof out === "string") {
      writeMarkdown(out, renderMarkdown(suite, results, names));
      console.log(`wrote ${out}`);
    }
    if (typeof flags.json === "string") {
      writeFileSync(flags.json, JSON.stringify(results, null, 2) + "\n");
      console.log(`wrote ${flags.json}`);
    }
    return;
  }

  fail(`unknown command "${cmd}". try agent-trials help`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
