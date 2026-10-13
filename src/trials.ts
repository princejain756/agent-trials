import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TrialTask {
  id: string;
  prompt: string;
  verify?: string;
}

export interface Suite {
  name?: string;
  setup?: string;
  verify?: string;
  verifyPaths?: string[];
  timeoutSec?: number;
  allowedEnv?: string[];
  tasks: TrialTask[];
  agents?: Record<string, { run: string[]; resultJson?: boolean; unsafe?: boolean }>;
}

export interface Cell {
  agent: string;
  task: string;
  pass: boolean;
  agentExit: number | null;
  verifyExit: number | null;
  sec: number;
  costUsd?: number;
  modelUsed?: string;
  verifyRestored?: string[];
  envWithheld?: number;
  skippedSymlinks?: string[];
  error?: string;
}

interface AgentSpec {
  argv: string[];
  resultJson?: boolean;
  unsafe?: boolean;
}

// These bypass agent approval prompts. They are the whole point of an
// unattended run, but they also mean the agent can touch anything your user
// can, so the CLI requires --unsafe before they are used.
export const BUILTIN_AGENTS: Record<string, AgentSpec> = {
  claude: {
    argv: ["claude", "-p", "{prompt}", "--dangerously-skip-permissions", "--output-format", "json"],
    resultJson: true,
    unsafe: true,
  },
  codex: { argv: ["codex", "exec", "--full-auto", "{prompt}"], unsafe: true },
  gemini: { argv: ["gemini", "-p", "{prompt}", "--yolo", "-o", "json"], resultJson: true, unsafe: true },
};

const SKIP_DIRS = new Set(["node_modules", ".git", ".agent-trials"]);

// Vars every child needs to function. Everything else is withheld unless the
// suite opts in via allowedEnv, so agent CLIs and verify commands never
// inherit API keys, cloud credentials, or CI tokens by default.
export const BASE_ENV = ["PATH", "HOME", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR", "TZ"];

// Credentials that live in the repo. Matched against the file name only, so a
// nested copy is caught too, but the patterns must not swallow ordinary files:
// `config.json` is a normal project file, `.env.example` is a checked-in
// template, and bare `credentials` is too generic to drop on sight.
const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env(\.local|\.development|\.production|\.test|\.staging|\.ci)?$/,
  /^\.env\.(?!example$|sample$|template$)[a-z0-9_.-]+$/i,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.pgpass$/,
  /^\.htpasswd$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx|keystore|jks|asc)$/i,
  /^\.p12$/,
];

// Directories whose entire contents are credentials or private keys.
const SECRET_DIR_NAMES = new Set([".aws", ".ssh", ".gnupg", ".docker", ".kube"]);

// Files that are only credentials when they sit in a credential directory.
const NESTED_SECRET_FILES = new Set(["credentials", "config", "config.json", "token", "id_rsa"]);

export function isSecretPath(name: string, parentDir = ""): boolean {
  if (SECRET_DIR_NAMES.has(name)) return true;
  if (SECRET_FILE_PATTERNS.some((re) => re.test(name))) return true;
  // `~/.aws/credentials` and `~/.kube/config` are secrets; `src/credentials.js`
  // and a project's own `config.json` are not.
  if (NESTED_SECRET_FILES.has(name) && SECRET_DIR_NAMES.has(parentDir)) return true;
  return false;
}

export function buildEnv(allowed: string[] | undefined): { env: NodeJS.ProcessEnv; withheld: string[] } {
  const keep = new Set([...BASE_ENV, ...(allowed ?? [])]);
  const env: NodeJS.ProcessEnv = {};
  const withheld: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (keep.has(key)) env[key] = process.env[key];
    else withheld.push(key);
  }
  return { env, withheld };
}

export function loadSuite(file: string): Suite {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file}: expected a JSON object at the top level`);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error(`${file}: needs a non-empty "tasks" array`);
  }
  const seenIds = new Set<string>();
  for (const t of raw.tasks) {
    if (!t.id || !t.prompt) throw new Error(`${file}: every task needs "id" and "prompt"`);
    if (typeof t.id !== "string") throw new Error(`${file}: task ids must be strings`);
    if (/[\\/]/.test(t.id) || t.id === "." || t.id === ".." || t.id.includes("..")) {
      throw new Error(`${file}: task id "${t.id}" must not contain a path separator or ".." (it names a temp dir)`);
    }
    if (seenIds.has(t.id)) {
      throw new Error(`${file}: duplicate task id "${t.id}"; ids must be unique or the board cannot tell them apart`);
    }
    seenIds.add(t.id);
    if (!t.verify && !raw.verify) throw new Error(`${file}: task "${t.id}" has no verify and suite has no default`);
  }
  if (raw.verifyPaths !== undefined && !Array.isArray(raw.verifyPaths)) {
    throw new Error(`${file}: "verifyPaths" must be an array of repo-relative paths`);
  }
  if (raw.timeoutSec !== undefined) {
    if (typeof raw.timeoutSec !== "number" || !Number.isFinite(raw.timeoutSec) || raw.timeoutSec <= 0) {
      throw new Error(`${file}: "timeoutSec" must be a positive number of seconds`);
    }
  }
  if (raw.allowedEnv !== undefined && !Array.isArray(raw.allowedEnv)) {
    throw new Error(`${file}: "allowedEnv" must be an array of variable names`);
  }
  return raw as Suite;
}

// Flags that turn off an agent's own approval prompts. A suite can define a
// custom agent that passes these directly, which would sidestep the builtin
// gate, so the argv itself is checked and not just the spec's `unsafe` marker.
const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "--yolo",
  "--force",
  "--no-confirm",
  "--auto-approve",
];

export function argvIsUnsafe(argv: string[]): boolean {
  return argv.some((a) => BYPASS_FLAGS.some((f) => a === f || a.startsWith(f + "=")));
}

export function resolveAgents(
  names: string[] | undefined,
  suite: Suite,
): Record<string, AgentSpec> {
  const custom = suite.agents ?? {};
  const all: Record<string, AgentSpec> = { ...BUILTIN_AGENTS };
  for (const [name, def] of Object.entries(custom)) {
    if (!Array.isArray(def.run) || def.run.length === 0) {
      throw new Error(`agent "${name}": "run" must be an argv array, e.g. ["sh","./agent.sh","{prompt}"]`);
    }
    // Redefining a builtin name must not silently drop its safety marking.
    const inheritsBuiltinSafety = BUILTIN_AGENTS[name]?.unsafe === true;
    all[name] = {
      argv: def.run,
      resultJson: def.resultJson === true,
      unsafe: def.unsafe === true || inheritsBuiltinSafety || argvIsUnsafe(def.run),
    };
  }
  if (!names || names.length === 0) return all;
  const picked: Record<string, AgentSpec> = {};
  for (const n of names) {
    if (!all[n]) throw new Error(`unknown agent "${n}". known: ${Object.keys(all).join(", ")}`);
    picked[n] = all[n];
  }
  return picked;
}

export function findSecrets(root: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    // Guard against a symlink loop and against scanning the same tree twice.
    if (seen.has(real)) return;
    seen.add(real);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = path.join(dir, entry);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // Symlinks are skipped from the copy, so only flag one when its own
        // name looks like a credential.
        if (isSecretPath(entry, path.basename(dir))) found.push(path.relative(root, abs));
        continue;
      }
      if (st.isDirectory()) {
        if (isSecretPath(entry)) found.push(path.relative(root, abs) + "/");
        else walk(abs, depth + 1);
      } else if (isSecretPath(entry, path.basename(dir))) {
        found.push(path.relative(root, abs));
      }
    }
  };
  walk(root, 0);
  return found;
}

// Symlinks are skipped by copyWorkdir, so tell the user which ones, otherwise a
// repo that relies on a linked directory looks mysteriously broken inside the
// run. Bounded like findSecrets to stay cheap on large trees.
export function findSymlinks(root: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = path.join(dir, entry);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        found.push(path.relative(root, abs));
      } else if (st.isDirectory()) {
        walk(abs, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

export function copyWorkdir(root: string, dest: string, allowSecrets = false): { skippedLinks: string[] } {
  const skippedLinks: string[] = [];
  cpSync(root, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      if (SKIP_DIRS.has(parts[0])) return false;

      // Skip every symlink. Preserving one hands the agent a path out of the
      // repo; dereferencing one copies files that were never in the repo, and a
      // link to an ancestor recurses forever. Neither belongs in the copy.
      let st;
      try {
        st = lstatSync(src);
      } catch {
        return false;
      }
      if (st.isSymbolicLink()) {
        skippedLinks.push(rel);
        return false;
      }

      if (allowSecrets) return true;
      // Judge the entry by its own name plus its immediate parent, so
      // `.aws/credentials` is dropped while `src/config.json` is kept.
      const name = parts[parts.length - 1];
      const parent = parts.length > 1 ? parts[parts.length - 2] : "";
      return !isSecretPath(name, parent);
    },
  });
  return { skippedLinks };
}

interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCmd(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<CmdResult> {
  return new Promise((resolve) => {
    // detached puts the child in its own process group so a timeout can signal
    // the whole group. Without it, `sh -c "npm test"` leaves the real command
    // running as an orphan writing into a directory we are about to delete.
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const cap = (s: string, chunk: Buffer) => {
      if (s.length >= 512_000) return s;
      const next = s + chunk.toString();
      // Keep the tail, not the head: an agent CLI prints its result JSON last,
      // so head-truncation would discard the cost and model fields.
      return next.length > 512_000 ? next.slice(next.length - 512_000) : next;
    };
    child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));

    let escalate: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Group already gone, or the pid was reaped.
        try {
          child.kill(signal);
        } catch {
          /* nothing left to kill */
        }
      }
    };

    const killer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      escalate = setTimeout(() => killGroup("SIGKILL"), 5000);
      escalate.unref();
    }, timeoutMs);

    const finish = (code: number | null, errText?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (escalate) clearTimeout(escalate);
      resolve({ code, stdout, stderr: errText ?? stderr, timedOut });
    };

    child.on("error", (err) => finish(null, String(err)));
    child.on("close", (code) => finish(code));
  });
}

function parseAgentJson(stdout: string): { costUsd?: number; modelUsed?: string } {
  try {
    const j = JSON.parse(stdout.trim());
    const cost = j.total_cost_usd ?? j.cost_usd ?? j.stats?.total_cost_usd;
    const out: { costUsd?: number; modelUsed?: string } = {};
    if (typeof cost === "number") out.costUsd = cost;
    const model = pickModel(j);
    if (model) out.modelUsed = model;
    return out;
  } catch {
    return {};
  }
}

// Agent CLIs report the model in different places and shapes. Reading the first
// key of modelUsage picks whatever the CLI happened to serialize first, which is
// not necessarily the model that did the work, so prefer an explicit field and
// only fall back to the usage map when it holds exactly one entry.
export function pickModel(j: any): string | undefined {
  const direct = j?.model ?? j?.model_name ?? j?.modelId ?? j?.stats?.model;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const usage = j?.modelUsage ?? j?.model_usage ?? j?.stats?.modelUsage;
  if (usage && typeof usage === "object") {
    const keys = Object.keys(usage).filter((k) => k.trim());
    if (keys.length === 1) return keys[0];
    if (keys.length > 1) {
      // Several models ran: report the one with the most output tokens, and
      // fall back to the first key when the CLI does not report token counts.
      let best = keys[0];
      let bestTokens = -1;
      for (const k of keys) {
        const entry = (usage as any)[k] ?? {};
        const tokens =
          entry?.output_tokens ?? entry?.outputTokens ?? entry?.output ?? entry?.total_tokens ?? 0;
        if (typeof tokens === "number" && tokens > bestTokens) {
          bestTokens = tokens;
          best = k;
        }
      }
      return best;
    }
  }
  return undefined;
}

// The checker files are restored from the source repo after the agent runs,
// so an agent cannot rewrite its own test. The suite marks them with
// verifyPaths; a top-level verify/ dir is the convention fallback.
function protectedPaths(root: string, suite: Suite): string[] {
  const rels =
    suite.verifyPaths ?? (existsSync(path.join(root, "verify")) ? ["verify"] : []);
  return rels.filter((rel) => {
    if (path.isAbsolute(rel)) return false;
    const parts = rel.split(/[\\/]+/);
    if (parts.includes("..") || parts.includes(".") || parts.includes("")) return false;
    if (SKIP_DIRS.has(parts[0])) return false;
    const abs = path.join(root, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return false;
    }
    // A symlinked checker path would be copied by cpSync by following it,
    // pulling an arbitrary directory from outside the repo into the sandbox.
    if (st.isSymbolicLink()) return false;
    return true;
  });
}

export interface RunOpts {
  root: string;
  suite: Suite;
  agents: Record<string, AgentSpec>;
  jobs: number;
  keep: boolean;
  allowSecrets?: boolean;
  onCell?: (cell: Cell) => void;
}

const liveSandboxes = new Set<string>();

function cleanupSandboxes(keep: boolean) {
  if (keep) return;
  for (const dir of liveSandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  liveSandboxes.clear();
}

let cleanupInstalled = false;
let cleanupKeep = false;
function installCleanup(keep: boolean) {
  // The handler reads the current value rather than closing over the first
  // caller's, so a later run with a different `keep` behaves correctly.
  cleanupKeep = keep;
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const handler = () => {
    cleanupSandboxes(cleanupKeep);
    process.exit(130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("exit", () => cleanupSandboxes(cleanupKeep));
}

export async function runSuite(opts: RunOpts): Promise<Cell[]> {
  const { root, suite, agents, jobs, keep, allowSecrets, onCell } = opts;
  const timeoutSec = Number(suite.timeoutSec);
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 600_000;
  const { env, withheld } = buildEnv(suite.allowedEnv);
  installCleanup(keep);
  const cells: { agent: string; spec: AgentSpec; task: TrialTask }[] = [];
  for (const [agent, spec] of Object.entries(agents)) {
    for (const task of suite.tasks) cells.push({ agent, spec, task });
  }

  // Results are written into the slot matching the cell, so `--json` output is
  // stable across runs instead of following worker completion order.
  const results: Cell[] = new Array(cells.length);
  let idx = 0;

  async function worker() {
    while (idx < cells.length) {
      const slot = idx++;
      const cell = cells[slot];
      const { agent, spec, task } = cell;
      const sandbox = mkdtempSync(path.join(tmpdir(), `agent-trials-${task.id}-`));
      liveSandboxes.add(sandbox);
      const t0 = Date.now();
      const out: Cell = {
        agent,
        task: task.id,
        pass: false,
        agentExit: null,
        verifyExit: null,
        sec: 0,
      };
      if (withheld.length) out.envWithheld = withheld.length;
      try {
        const { skippedLinks } = copyWorkdir(root, sandbox, allowSecrets === true);
        if (skippedLinks.length) out.skippedSymlinks = skippedLinks;
        if (suite.setup) {
          const s = await runCmd(["sh", "-c", suite.setup], sandbox, timeoutMs, env);
          if (s.code !== 0) throw new Error(`setup failed (${s.code}): ${s.stderr.slice(-200)}`);
        }
        const argv = spec.argv.map((a) => (a === "{prompt}" ? task.prompt : a));
        if (!spec.argv.includes("{prompt}")) argv.push(task.prompt);
        const agentRes = await runCmd(argv, sandbox, timeoutMs, env);
        out.agentExit = agentRes.code;
        if (spec.resultJson) Object.assign(out, parseAgentJson(agentRes.stdout));
        if (agentRes.code === null) {
          out.error = agentRes.timedOut ? "timeout" : `spawn failed: ${agentRes.stderr.slice(-160)}`;
        }
        const verifyCmd = task.verify ?? suite.verify!;
        const restored = protectedPaths(root, suite);
        for (const rel of restored) {
          const target = path.join(sandbox, rel);
          // Clear first: copying over a directory leaves any extra file the
          // agent added inside it, and those files can then run as part of the
          // verify command.
          rmSync(target, { recursive: true, force: true });
          cpSync(path.join(root, rel), target, { recursive: true });
        }
        if (restored.length) out.verifyRestored = restored;
        const v = await runCmd(["sh", "-c", verifyCmd], sandbox, timeoutMs, env);
        out.verifyExit = v.code;
        out.pass = out.agentExit === 0 && v.code === 0;
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
      } finally {
        out.sec = Math.round((Date.now() - t0) / 100) / 10;
        if (!keep) {
          rmSync(sandbox, { recursive: true, force: true });
          liveSandboxes.delete(sandbox);
        }
        results[slot] = out;
        // onCell is user-supplied; a throw here must not kill the worker and
        // reject the whole run, which would leak the remaining sandboxes.
        try {
          onCell?.(out);
        } catch {
          /* reporting failure is not a run failure */
        }
      }
    }
  }

  const workerCount = Number.isFinite(jobs) && jobs >= 1 ? Math.min(Math.floor(jobs), 32) : 2;
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarize(results: Cell[], agentNames: string[]) {
  return agentNames.map((agent) => {
    const cells = results.filter((r) => r.agent === agent);
    const passes = cells.filter((r) => r.pass).length;
    const costs = cells.map((r) => r.costUsd).filter((c): c is number => typeof c === "number");
    return {
      agent,
      passes,
      total: cells.length,
      medianSec: median(cells.map((r) => r.sec)),
      totalCost: costs.length ? costs.reduce((a, b) => a + b, 0) : undefined,
    };
  });
}

export function verdictOf(c: Cell): string {
  if (c.error || c.agentExit !== 0) return "err";
  return c.pass ? "pass" : "fail";
}

export function renderBoard(
  suite: Suite,
  results: Cell[],
  agentNames: string[],
): string {
  const taskIds = suite.tasks.map((t) => t.id);
  const find = (a: string, t: string) => results.find((r) => r.agent === a && r.task === t);
  const colW = agentNames.map(
    (a) =>
      Math.max(
        a.length,
        ...taskIds.map((t) => {
          const c = find(a, t);
          return c ? `${verdictOf(c)} ${c.sec}s`.length : 1;
        }),
      ) + 2,
  );
  const taskW = Math.max(...taskIds.map((t) => t.length), "median".length) + 2;

  const lines: string[] = [];
  lines.push(
    `agent-trials · ${taskIds.length} task${taskIds.length === 1 ? "" : "s"} · ${agentNames.length} agent${agentNames.length === 1 ? "" : "s"}`,
  );
  lines.push("");
  lines.push(
    "".padEnd(taskW) + agentNames.map((a, i) => a.padStart(colW[i])).join(""),
  );
  for (const tid of taskIds) {
    const row = agentNames
      .map((a, i) => {
        const c = find(a, tid);
        const label = c ? `${verdictOf(c)} ${c.sec}s` : "-";
        return label.padStart(colW[i]);
      })
      .join("");
    lines.push(tid.padEnd(taskW) + row);
  }
  lines.push("");
  const sums = summarize(results, agentNames);
  lines.push(
    "score".padEnd(taskW) +
      sums.map((s, i) => `${s.passes}/${s.total}`.padStart(colW[i])).join(""),
  );
  lines.push(
    "median".padEnd(taskW) +
      sums.map((s, i) => `${s.medianSec}s`.padStart(colW[i])).join(""),
  );
  if (sums.some((s) => s.totalCost !== undefined)) {
    lines.push(
      "cost".padEnd(taskW) +
        sums
          .map((s) => (s.totalCost === undefined ? "-" : `$${s.totalCost.toFixed(2)}`))
          .map((x, i) => x.padStart(colW[i]))
          .join(""),
    );
  }
  const best = [...sums].sort(
    (a, b) => b.passes - a.passes || a.medianSec - b.medianSec,
  )[0];
  if (best && sums.length > 1) {
    lines.push("");
    lines.push(`winner: ${best.agent} (${best.passes}/${best.total}, median ${best.medianSec}s)`);
  }
  return lines.join("\n");
}

export function renderMarkdown(
  suite: Suite,
  results: Cell[],
  agentNames: string[],
): string {
  const sums = summarize(results, agentNames);
  const find = (a: string, t: string) => results.find((r) => r.agent === a && r.task === t);
  const head = `| task | ${agentNames.join(" | ")} |`;
  const sep = `|${"---|".repeat(agentNames.length + 1)}`;
  const rows = suite.tasks.map((t) => {
    const cells = agentNames
      .map((a) => {
        const c = find(a, t.id);
        if (!c) return "-";
        const verdict = verdictOf(c);
        const cost = c.costUsd !== undefined ? ` · $${c.costUsd.toFixed(2)}` : "";
        return `${verdict} · ${c.sec}s${cost}`;
      })
      .join(" | ");
    return `| ${t.id} | ${cells} |`;
  });
  const totals = `| **score** | ${sums.map((s) => `**${s.passes}/${s.total}**`).join(" | ")} |`;
  const med = `| median | ${sums.map((s) => `${s.medianSec}s`).join(" | ")} |`;
  const when = new Date().toISOString().slice(0, 10);
  return [
    `# agent-trials results`,
    ``,
    `${suite.name ?? "suite"} · run ${when} · ${suite.tasks.length} tasks × ${agentNames.length} agents`,
    ``,
    head,
    sep,
    ...rows,
    totals,
    med,
    ``,
    `Generated by [agent-trials](https://github.com/princejain756/agent-trials)`,
  ].join("\n");
}

export function writeMarkdown(file: string, content: string): void {
  writeFileSync(file, content + "\n");
}

export function agentInstalled(argv0: string): boolean {
  const which = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(which, [argv0], { stdio: "ignore" });
  return res.status === 0;
}

export function suiteFileExists(file: string): boolean {
  return existsSync(file);
}
