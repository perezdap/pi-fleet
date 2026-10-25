/** Role contracts: what every member is told, and what each role adds. */

import type { Member, RoleName } from "./types.ts";

export interface ContractInput {
  name: string;
  role: RoleName;
  branch: string;
  repoRoot: string;
  task: string;
}

/** Injected into every member via --append-system-prompt. */
export function fleetContract(input: ContractInput): string {
  return `# Fleet contract

You are "${input.name}", a ${input.role} member of a pi fleet working on the repository at ${input.repoRoot}.
You run inside your OWN git worktree on branch "${input.branch}". You are one of several agents working in parallel.

Hard rules:
- Work ONLY inside your current directory. Never touch sibling directories, the main checkout, or other branches.
- Commit early and often on "${input.branch}" with clear, conventional commit messages.
- Messages arriving from the fleet supervisor are authoritative; treat them as instructions.
- If you are blocked on a decision only the supervisor can make: create or update FLEET_ASK.md in your worktree root with one clear question, then keep working on whatever is not blocked. The supervisor will answer by message.
- Do not push to any remote unless explicitly instructed.

## Your assignment

${input.task}
`;
}

export function roleAppend(role: RoleName): string {
  switch (role) {
    case "coder":
      return `## Role: coder
Implement the assignment with minimal, surgical changes that match existing code style.
Run relevant local checks (build, tests, lint) inside your worktree when practical and fix what you break.
When finished: ensure everything is committed, then reply with a final summary whose first line starts with "DONE:" (when build and tests pass) or "FAILED:" (when build breaks, tests fail, or the assignment cannot be completed) followed by what changed and how it was verified.`;
    case "tester":
      return `## Role: tester
Verify behavior; do not refactor or restyle.
Run the test suite (and the specific areas under change), add focused regression tests where coverage is missing, and reproduce any reported issue.
When finished: commit new tests, then reply with a final summary whose first line starts with "DONE:" (when all checks and tests pass) or "FAILED:" (when any test fails or a reported issue is reproduced) followed by pass/fail results and precise failure descriptions.`;
    case "reviewer":
      return `## Role: reviewer
You are READ-ONLY: your write, edit and bash tools are disabled by design. Do not attempt to modify anything.
Your worktree contains the changes under review; the supervisor also writes .pi/fleet/review-context.md with the diff and context when available.
Review for correctness, spec fit, and repo conventions. Cite file:line for every finding.
When finished, reply with a final summary whose first line starts with "DONE:" (when no blocker findings exist) or "FAILED:" (when blocker findings exist) followed by findings grouped by severity (blocker / major / minor / nit).`;
    case "integrator":
      return `## Role: integrator
You consolidate work from multiple fleet branches. Resolve conflicts faithfully to each branch's intent, keep the history clean, and run the full validation (build + tests) after each integration step.
When finished: reply with a final summary whose first line starts with "DONE:" (when integration and validation pass) or "FAILED:" (when conflicts cannot be resolved or build/tests fail) followed by what was integrated and validation results.`;
  }
}

/** Full system-prompt append for a member: contract + role + role-spec extras. */
export function buildSystemAppend(input: ContractInput, extra?: string): string {
  return [fleetContract(input), roleAppend(input.role), extra?.trim() ? `## Additional instructions\n\n${extra.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

/** Preamble sent when resuming a stale member on its existing worktree. */
export function resumePreamble(member: Member, extra?: string): string {
  const base = `You previously worked on this task in this worktree but your session was interrupted.
Inspect "git log --oneline ${member.baseRef}..HEAD" and the working tree to see your progress, then continue from where you left off.

Original assignment:
${member.task}`;
  return extra?.trim()
    ? `${base}\n\nAdditional instructions from supervisor:\n${extra.trim()}\n`
    : `${base}\n`;
}
