# agent-trials

Interview your coding agent before you ship with it.

`agent-trials` runs the same task suite through every coding agent CLI you have installed and prints a scoreboard: who passed, how long they took, what they spent. Every task runs in a throwaway copy of your repo, so agents can do their worst and your working tree stays clean.

![demo](demo.png)

## why

Public benchmarks score agents on tasks someone else picked. Your repo is not that benchmark. The question that matters before you let an agent loose on a codebase: does it fix YOUR bugs, in YOUR stack, at a sane price? Write the tasks once, run every candidate, keep the receipts.

## install

```sh
npx agent-trials init        # writes trials.json in your repo
```

Works straight from GitHub too: `npx github:princejain756/agent-trials`.

## use

```sh
agent-trials init           # starter suite
agent-trials doctor         # which agent CLIs are installed
agent-trials run            # run the suite, print the board, write TRIALS.md
```

## trials.json

```json
{
  "verify": "npm test",
  "timeoutSec": 600,
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

Each cell (agent x task) works like this:

1. your repo, minus `node_modules` and `.git`, is copied to a temp sandbox
2. optional `setup` command runs once (`npm ci` and friends)
3. the agent runs headless on the task prompt, permission checks off, timeout-guarded
4. your `verify` command runs in the sandbox; exit 0 means pass

Builtin agents: `claude`, `codex`, `gemini`. Custom agents are one argv array away: anything installed, any flags, `{prompt}` gets replaced with the task prompt.

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

What the board caught:

- haiku, the cheap one, went 3/3 with the fastest median. It also spent the most: $2.06, because it ran more turns. Pass rate and price do not move together.
- an earlier run caught the agent asking a clarifying question ("should -0 count as zero?") into an empty terminal, then exiting 0 having changed nothing. Exit code means nothing; your verify command is the ground truth.
- sonnet lost slug-test outright. The task was write a test file that runs clean under plain node; it didn't.

Full results with per-cell costs: [LEADERBOARD.md](LEADERBOARD.md)

## limits, honestly

- pass/fail is your verify command's exit code. The tool cannot judge taste, only outcomes.
- runs spend your agent quota and your auth; costs are reported when the agent's JSON output includes them (claude does)
- agent CLIs must be installed and logged in
- macOS/Linux; the sandbox copy and verify assume `sh`. Windows untested
- scoring is binary per task. No partial credit for "almost fixed it"

## flags

| flag | default | what it does |
|---|---|---|
| `--suite <file>` | `trials.json` | suite file to run |
| `--agents a,b` | all known | restrict the agent list |
| `--root <dir>` | `.` | the repo being tested |
| `--jobs <n>` | `2` | parallel agent x task cells |
| `--out <file>` | `TRIALS.md` | markdown report path, `none` skips |
| `--json <file>` | - | raw per-cell results |
| `--keep` | off | keep sandboxes under /tmp for debugging |

## why the suite format is the point

Tasks are plain JSON and `verify` is plain shell, so a suite doubles as a smoke-test pack for humans. Commit `trials.json` next to the code it describes. When you swap agents or bump model versions, rerun and diff the board.

MIT
