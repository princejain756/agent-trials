# agent-trials

Interview your coding agent before you ship with it.

`agent-trials` runs the same task suite through every coding agent CLI you have installed and prints a scoreboard: who passed, how long they took, what they spent. Each task gets a temporary working copy. Commands still run on your host.

![demo](demo.png)

## why

Public benchmarks score agents on tasks someone else picked. Your repo is not that benchmark. The question that matters before you let an agent loose on a codebase: does it fix YOUR bugs, in YOUR stack, at a sane price? Write the tasks once, run every candidate, keep the receipts.

## execution safety

Agents are untrusted code. This tool runs them unattended, which means it is not, and cannot be, a security sandbox. What it does give you:

- **credentials are withheld.** Agents and verify commands get a minimal environment: `PATH`, `HOME`, `SHELL`, `TERM`, `LANG`, `TMPDIR`, `TZ`. Everything else is dropped. `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY` and the rest do not reach the child process. A suite can opt specific vars back in with `allowedEnv`.
- **secret files are skipped.** `.env`, `.env.local`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, `.netrc`, `.aws/`, `.ssh/` and similar are never copied into the working copy. The run prints what it skipped. Ordinary files are left alone: `config.json`, `src/config.json`, `.env.example` and `credentials.js` are not secrets and stay put. `--allow-secrets` overrides this if you have a reason.
- **symlinks are skipped.** A link copied into the working copy hands the agent a path out of your repo, and dereferencing one imports files that were never in the repo. Neither happens: links are dropped and the run lists them, so you can see why a linked directory looks empty inside a run.
- **unsafe flags are opt-in.** Builtin `claude`, `codex`, and `gemini` specs disable approval prompts (`--dangerously-skip-permissions`, `--full-auto`, `--yolo`) and the tool refuses to run them without `--unsafe`. The check reads the argv, so redefining a builtin name, or writing a custom agent that passes a bypass flag, still requires `--unsafe`.
- **timeouts kill the process group.** A timed-out cell signals the child and everything it spawned, so a killed `npm test` does not keep running against a directory that is being deleted.
- **temporary copies are cleaned up.** On normal exit, on Ctrl-C, and on SIGTERM. `--keep` leaves them and prints the paths.

What it still does not do:

- the working copy is **not** a security sandbox. Agents run with your user's permissions and can read and write outside the copy. Skipping symlinks and secrets narrows what is handed to them; it does not contain them.
- an agent with network access can exfiltrate anything it can read, including your source.
- `verifyPaths` are restored from your repo after the agent runs so it cannot rewrite its own test, but a verify command that reads mutable state elsewhere can still be gamed. A `verifyPaths` entry that is itself a symlink is refused.

**Run this in a disposable VM with no sensitive files or credentials.** That sentence was true before and it is still true now. Use only suites you trust.

## install

```sh
npx agent-trials init        # writes trials.json in your repo
```

Works straight from GitHub too: `npx github:princejain756/agent-trials`.

## use

```sh
agent-trials init           # starter suite
agent-trials doctor         # which agent CLIs are installed
agent-trials run --unsafe   # run the suite, print the board, write TRIALS.md
```

`--unsafe` is required whenever the selected agents are the builtins, because those specs disable the agent's own approval prompts. Without it the run stops and tells you which agents it means.

## trials.json

```json
{
  "verify": "npm test",
  "verifyPaths": ["verify"],
  "timeoutSec": 600,
  "allowedEnv": ["ANTHROPIC_API_KEY"],
  "tasks": [
    {
      "id": "fix-cache",
      "prompt": "The cache in src/cache.js never expires entries. Add a ttl option. Keep the API.",
      "verify": "node checks/cache-ttl.mjs"
    }
  ],
  "agents": {
    "sonnet": { "run": ["claude", "-p", "{prompt}", "--dangerously-skip-permissions", "--model", "sonnet"] }
  }
}
```

`allowedEnv` is optional. Without it the agent gets only `PATH`, `HOME`, `SHELL`, `TERM`, `LANG`, `LC_ALL`, `TMPDIR`, `TZ`. Agent CLIs usually read their own auth from a config file in `HOME`, so you often do not need this; add a var only when a CLI genuinely needs it from the environment.

Each cell (agent x task) works like this:

1. your repo, minus `node_modules`, `.git`, and secret-looking files, is copied to a temporary working copy
2. optional `setup` command runs once (`npm ci` and friends)
3. the agent runs headless on the task prompt, using the selected CLI flags, timeout-guarded, with a minimal environment
4. checker paths are restored from your repo, so the agent cannot rewrite its own test
5. your `verify` command runs in the working copy; exit 0 means pass

Step 4 restores `verifyPaths` from the suite, or a top-level `verify/` dir when `verifyPaths` is not set. A verify command that reads mutable state outside those paths can still be gamed; put your checkers in `verify/` or list them.

Builtin agents: `claude`, `codex`, `gemini`. Custom agents are one argv array away: anything installed, any flags, `{prompt}` gets replaced with the task prompt.

The `--unsafe` gate is not limited to the builtins. Any agent whose argv contains a known approval-bypass flag (`--dangerously-skip-permissions`, `--full-auto`, `--yolo`, `--force`, `--auto-approve` and friends) requires `--unsafe` too, including a custom agent that reuses a builtin name. A plain command like `["sh", "./agent.sh", "{prompt}"]` runs with no flag.

## a real run

`examples/tinylib` is a 3-function library with planted bugs. Same 3 tasks, 3 model variants of the same agent CLI (`claude --model`):

```
agent-trials · 3 tasks · 3 agents

                  opus      sonnet       haiku
fix-clamp    pass 141.3s  pass 44.2s   pass 60.9s
divide-guard  fail 96.1s  pass 72.1s  pass 118.6s
slug-test    pass 253.4s  fail 124.4s    pass 50s

score              2/3         2/3           3/3
median          141.3s       72.1s         60.9s
cost             $1.11       $1.10         $2.06

winner: haiku (3/3, median 60.9s)
```

Read this board with caveats. `opus`, `sonnet`, and `haiku` are requested CLI aliases; that run predates model-identity capture (`--json` now records `modelUsed` per cell when the agent CLI reports it). One run of three toy tasks is a smoke test, not a comparative benchmark. Costs are CLI-reported, not invoice costs.

What the board caught:

- haiku went 3/3 with the fastest median while spending the most: $2.06. Pass rate and price did not move together.
- in one earlier run, the agent asked a clarifying question ("should -0 count as zero?") into an empty terminal, then exited 0 having changed nothing. One observed example, not a general claim. This showed why exit code alone cannot be the verdict; the verify command is what counts.
- sonnet failed slug-test.

Full results with per-cell costs: [LEADERBOARD.md](LEADERBOARD.md)

## limits, honestly

- pass/fail is your verify command's exit code. The tool cannot judge taste, only outcomes.
- runs spend your agent quota and your auth; costs are reported when the agent's JSON output includes them (claude does)
- agent CLIs must be installed and logged in
- macOS/Linux; the working copy and verify assume `sh`. Windows untested
- scoring is binary per task. No partial credit for "almost fixed it"
- the working copy is not a security sandbox. Credentials and secret files are withheld, but the agent still runs as your user on your machine. Use a disposable VM

## flags

| flag | default | what it does |
|---|---|---|
| `--suite <file>` | `trials.json` | suite file to run |
| `--agents a,b` | all known | restrict the agent list |
| `--root <dir>` | `.` | the repo being tested |
| `--jobs <n>` | `2` | parallel agent x task cells |
| `--out <file>` | `TRIALS.md` | markdown report path, `none` skips |
| `--json <file>` | - | raw per-cell results |
| `--keep` | off | keep working copies under /tmp for debugging |
| `--unsafe` | off | allow builtin agents to run with approval prompts disabled |
| `--allow-secrets` | off | copy secret-looking files into the workdir |

## why the suite format is the point

Tasks are plain JSON and `verify` is plain shell, so a suite doubles as a smoke-test pack for humans. Commit `trials.json` next to the code it describes. When you swap agents or bump model versions, rerun and diff the board.

MIT
