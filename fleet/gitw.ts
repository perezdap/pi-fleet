/** Thin git helpers used by the fleet (worktrees, merges, branch state). */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await pExecFile("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function tryGit(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, ...args) };
  } catch (err: any) {
    return { ok: false, out: String(err?.stderr ?? err?.message ?? err) };
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "--show-toplevel");
}

export async function headRev(cwd: string, ref = "HEAD"): Promise<string> {
  return git(cwd, "rev-parse", ref);
}

export async function addWorktree(
  root: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  await git(root, "worktree", "add", worktreePath, "-b", branch, baseRef);
}

/** Re-attach an existing branch as a worktree (resume after manual cleanup). */
export async function attachWorktree(
  root: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await git(root, "worktree", "add", worktreePath, branch);
}

export async function removeWorktree(
  root: string,
  worktreePath: string,
  force = false,
): Promise<{ ok: boolean; out: string }> {
  return tryGit(root, "worktree", "remove", ...(force ? ["--force"] : []), worktreePath);
}

export async function deleteBranch(root: string, branch: string, force = false): Promise<{ ok: boolean; out: string }> {
  return tryGit(root, "branch", force ? "-D" : "-d", branch);
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  const r = await tryGit(root, "rev-parse", "--verify", `refs/heads/${branch}`);
  return r.ok;
}

/** True when `branch` is fully merged into HEAD of `root`. */
export async function branchMerged(root: string, branch: string): Promise<boolean> {
  const r = await tryGit(root, "merge-base", "--is-ancestor", branch, "HEAD");
  return r.ok;
}

/** One-line commits on `branch` since `baseRef`. */
export async function commitsSince(root: string, baseRef: string, branch: string): Promise<string[]> {
  const r = await tryGit(root, "log", "--oneline", `${baseRef}..${branch}`);
  return r.ok ? r.out.split("\n").filter(Boolean) : [];
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
  output: string;
}

/** Merge `branch` into the current HEAD of `root`. Aborts on conflict and reports files. */
export async function mergeBranch(root: string, branch: string, message: string): Promise<MergeResult> {
  const r = await tryGit(root, "merge", "--no-ff", branch, "-m", message);
  if (r.ok) return { ok: true, conflicts: [], output: r.out };
  const u = await tryGit(root, "diff", "--name-only", "--diff-filter=U");
  const conflicts = u.ok ? u.out.split("\n").filter(Boolean) : [];
  await tryGit(root, "merge", "--abort");
  return { ok: false, conflicts, output: r.out };
}

/** Diff stat between baseRef and branch (for review context). */
export async function diffForReview(root: string, baseRef: string, branch: string): Promise<string> {
  const stat = await tryGit(root, "diff", "--stat", `${baseRef}...${branch}`);
  const diff = await tryGit(root, "diff", `${baseRef}...${branch}`);
  return [stat.ok ? stat.out : "", diff.ok ? diff.out : ""].filter(Boolean).join("\n\n");
}
