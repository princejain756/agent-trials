import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  tasks: TrialTask[];
  agents?: Record<string, { run: string[]; resultJson?: boolean }>;
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
  error?: string;
}

interface AgentSpec {
  argv: string[];
  resultJson?: boolean;
}

export const BUILTIN_AGENTS: Record<string, AgentSpec> = {
  claude: {
    argv: ["claude", "-p", "{prompt}", "--dangerously-skip-permissions", "--output-format", "json"],
    resultJson: true,
  },
  codex: { argv: ["codex", "exec", "--full-auto", "{prompt}"] },
  gemini: { argv: ["gemini", "-p", "{prompt}", "--yolo", "-o", "json"], resultJson: true },
};

const SKIP_DIRS = new Set(["node_modules", ".git", ".agent-trials"]);

export function loadSuite(file: string): Suite {
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error(`${file}: needs a non-empty "tasks" array`);
  }
  for (const t of raw.tasks) {
    if (!t.id || !t.prompt) throw new Error(`${file}: every task needs "id" and "prompt"`);
    if (!t.verify && !raw.verify) throw new Error(`${file}: task "${t.id}" has no verify and suite has no default`);
  }
  if (raw.verifyPaths !== undefined && !Array.isArray(raw.verifyPaths)) {
    throw new Error(`${file}: "verifyPaths" must be an array of repo-relative paths`);
  }
  return raw as Suite;
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
    all[name] = { argv: def.run, resultJson: def.resultJson === true };
  }
  if (!names || names.length === 0) return all;
  const picked: Record<string, AgentSpec> = {};
  for (const n of names) {
    if (!all[n]) throw new Error(`unknown agent "${n}". known: ${Object.keys(all).join(", ")}`);
    picked[n] = all[n];
  }
  return picked;
}

export function copyWorkdir(root: string, dest: string): void {
  cpSync(root, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      if (!rel) return true;
      const first = rel.split(path.sep)[0];
      return !SKIP_DIRS.has(first);
    },
  });
}

interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCmd(argv: string[], cwd: string, timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, chunk: Buffer) => (s.length < 512_000 ? s + chunk.toString() : s);
    child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ code: null, stdout, stderr: String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function parseAgentJson(stdout: string): { costUsd?: number; modelUsed?: string } {
  try {
    const j = JSON.parse(stdout.trim());
    const cost = j.total_cost_usd ?? j.cost_usd ?? j.stats?.total_cost_usd;
    const model = j.model ?? Object.keys(j.modelUsage ?? {})[0];
    const out: { costUsd?: number; modelUsed?: string } = {};
    if (typeof cost === "number") out.costUsd = cost;
    if (typeof model === "string" && model) out.modelUsed = model;
    return out;
  } catch {
    return {};
  }
}

// The checker files are restored from the source repo after the agent runs,
// so an agent cannot rewrite its own test. The suite marks them with
// verifyPaths; a top-level verify/ dir is the convention fallback.
function protectedPaths(root: string, suite: Suite): string[] {
  const rels =
    suite.verifyPaths ?? (existsSync(path.join(root, "verify")) ? ["verify"] : []);
  return rels.filter(
    (rel) =>
      !path.isAbsolute(rel) &&
      !rel.split(/[\\/]+/).includes("..") &&
      !SKIP_DIRS.has(rel.split(/[\\/]+/)[0]) &&
      existsSync(path.join(root, rel)),
  );
}

export interface RunOpts {
  root: string;
  suite: Suite;
  agents: Record<string, AgentSpec>;
  jobs: number;
  keep: boolean;
  onCell?: (cell: Cell) => void;
}

export async function runSuite(opts: RunOpts): Promise<Cell[]> {
  const { root, suite, agents, jobs, keep, onCell } = opts;
  const timeoutMs = (suite.timeoutSec ?? 600) * 1000;
  const cells: { agent: string; spec: AgentSpec; task: TrialTask }[] = [];
  for (const [agent, spec] of Object.entries(agents)) {
    for (const task of suite.tasks) cells.push({ agent, spec, task });
  }

  const results: Cell[] = [];
  let idx = 0;

  async function worker() {
    while (idx < cells.length) {
      const cell = cells[idx++];
      const { agent, spec, task } = cell;
      const sandbox = mkdtempSync(path.join(tmpdir(), `agent-trials-${task.id}-`));
      const t0 = Date.now();
      const out: Cell = {
        agent,
        task: task.id,
        pass: false,
        agentExit: null,
        verifyExit: null,
        sec: 0,
      };
      try {
        copyWorkdir(root, sandbox);
        if (suite.setup) {
          const s = await runCmd(["sh", "-c", suite.setup], sandbox, timeoutMs);
          if (s.code !== 0) throw new Error(`setup failed (${s.code}): ${s.stderr.slice(-200)}`);
        }
        const argv = spec.argv.map((a) => (a === "{prompt}" ? task.prompt : a));
        if (!spec.argv.includes("{prompt}")) argv.push(task.prompt);
        const agentRes = await runCmd(argv, sandbox, timeoutMs);
        out.agentExit = agentRes.code;
        if (spec.resultJson) Object.assign(out, parseAgentJson(agentRes.stdout));
        if (agentRes.code === null) {
          out.error = agentRes.timedOut ? "timeout" : `spawn failed: ${agentRes.stderr.slice(-160)}`;
        }
        const verifyCmd = task.verify ?? suite.verify!;
        const restored = protectedPaths(root, suite);
        for (const rel of restored) {
          cpSync(path.join(root, rel), path.join(sandbox, rel), { recursive: true });
        }
        if (restored.length) out.verifyRestored = restored;
        const v = await runCmd(["sh", "-c", verifyCmd], sandbox, timeoutMs);
        out.verifyExit = v.code;
        out.pass = out.agentExit === 0 && v.code === 0;
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
      } finally {
        out.sec = Math.round((Date.now() - t0) / 100) / 10;
        if (!keep) rmSync(sandbox, { recursive: true, force: true });
        results.push(out);
        onCell?.(out);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
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
