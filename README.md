# pi-fleet

Run a **fleet of pi coding agents in isolated git worktrees**, orchestrated from
one supervisor session. No dependencies beyond pi itself: this extension only
uses pi's extension API, pi's own CLI in RPC mode (`pi --mode rpc`), git, and
Node built-ins.

## How it works

- Your current pi session is the **supervisor**.
- `/fleet spawn <name> <task>` creates a git worktree
  (`.pi/fleet/wt/<name>`, branch `fleet/<name>`), starts a headless
  `pi --mode rpc` process inside it, and sends the task.
- Members work in parallel with **zero write collisions** — one branch, one
  writer per worktree. Integration happens explicitly via `/fleet merge`.
- A manifest (`.pi/fleet/manifest.json`) is the disk-truth registry, so state
  survives supervisor restarts; stale members can be resumed.

```
/fleet status
fleet: 3 members (2 active)
 ⚙ api [coder] status=running branch=fleet/api
 ○ ui [coder] status=idle branch=fleet/ui
 ✓ review-api [reviewer] status=done branch=fleet/review-api
```

## Commands

| Command | Description |
|---|---|
| `/fleet status` | Show all members (also shown as a status widget) |
| `/fleet spawn [--role r] [--model m] [--over ref] <name> <task…>` | Start a member |
| `/fleet resume <name> [extra…]` | Continue a stale/stopped member on its existing worktree |
| `/fleet send <name> <message…>` | Steer a busy member, or prompt an idle one |
| `/fleet wait [name\|--all] [--any] [--timeout <sec>]` | Wait for member(s) to settle or raise a question |
| `/fleet log <name> [n]` | Tail the member's recorded activity |
| `/fleet merge <name\|--done>` | Merge a member branch into HEAD (aborts + reports on conflict) |
| `/fleet stop <name\|--all>` | Abort + kill member process(es) |
| `/fleet clean <name\|--done\|--all> [--force]` | Remove worktree; delete branch if merged |
| `/fleet open <name>` | Resume the member's session in a new interactive pi window |

The extension also registers a **`fleet` tool**, so the supervisor LLM can
spawn, steer, merge, and clean members by itself.

## Roles: who codes, tests, reviews, consolidates

Roles are contracts injected into each member's system prompt, plus tool/model
policy. Built-ins:

| Role | Responsibility | Tool policy |
|---|---|---|
| `coder` | Implement the task; run local checks; commit often | full tools |
| `tester` | Run suites, add regression tests, report failures precisely | full tools |
| `reviewer` | Review the diff; findings with file:line; **cannot modify files** | `read,grep,find,ls` only |
| `integrator` | Consolidate branches, resolve conflicts, run full validation | full tools |

Typical flow:

1. Spawn one `coder` per task → they work in parallel, commit to their branches.
2. `/fleet merge --done` (supervisor merges sequentially, surfaces conflicts).
3. Spawn a `tester` on the integrated state to validate.
4. Spawn a `reviewer` with `--over <branch>`: its worktree starts from the
   branch under review, and the diff is dropped into
   `.pi/fleet/review-context.md` for it. Read-only is *enforced* via the tool
   allowlist, not just instructions.
5. If merges conflict badly, spawn an `integrator`.

## Different models per role (yes)

Every role can pin a model (any `provider/id:thinking` pattern pi accepts),
and any spawn can override it:

```jsonc
// .pi/fleet/config.json  (all keys optional)
{
  "maxMembers": 6,
  "baseRef": "HEAD",
  "defaultRole": "coder",
  "roles": {
    "coder":      { "model": "anthropic/claude-sonnet-4-5" },
    "tester":     { "model": "anthropic/claude-haiku-4-5" },
    "reviewer":   { "model": "anthropic/claude-opus-4-5", "thinking": "high" },
    "integrator": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high" }
  }
}
```

Per-spawn override: `/fleet spawn --role reviewer --model openai/gpt-5 r1 "Review the auth work"`.

## Coordination protocol

- **Supervisor → member:** direct RPC (`/fleet send`).
- **Member → supervisor:**
  - Members reply `DONE: …` when finished (detected → status `done` + notify).
  - Blocked members write `FLEET_ASK.md` in their worktree root; the supervisor
    watches it, notifies you, and answers via `/fleet send`.
  - All progress is git commits on the member branch — inspectable anytime.

## Install / dev

Requires pi ≥ 0.84 with `--mode rpc`.

```bash
# quick test in any git repo (macOS/Linux/WSL):
pi -e /path/to/pi-fleet/fleet/index.ts
```

```powershell
# quick test in any git repo (Windows):
pi -e C:\path\to\pi-fleet\fleet\index.ts
```

Or install as a package (once published), or copy/symlink this repo's `fleet/`
directory into `~/.pi/agent/extensions/pi-fleet/`.

### Typechecking locally

`tsconfig.json` resolves `@earendil-works/pi-coding-agent` from a local
`node_modules/`. If your pi installation lives elsewhere, copy `tsconfig.json`
to `tsconfig.local.json` (gitignored), point its `paths` at your pi install,
and run `tsc -p tsconfig.local.json --noEmit`.

## Files

```
fleet/
├── index.ts    # extension entry: /fleet command + fleet tool + lifecycle
├── fleet.ts    # Fleet controller: spawn/send/merge/stop/clean/reconcile
├── rpc.ts      # JSONL client for pi --mode rpc members
├── gitw.ts     # git worktree/merge helpers
├── manifest.ts # manifest persistence + pid checks
├── config.ts   # .pi/fleet/config.json + built-in role defaults
├── roles.ts    # fleet contract + per-role instructions
└── types.ts    # shared types
```

## Known limitations (v0.1)

- Member processes are tied to the supervisor process lifetime (stdin pipe).
  If pi exits, members exit; worktrees/branches/commits survive, and
  `/fleet resume` restarts a member where it left off.
- Merge conflict resolution is manual (or delegated to an `integrator`).
- Reviewer role policy is enforced via `--tools`, but `coder`/`tester` rely on
  the contract (they stay inside their worktree by instruction, not sandbox).
