/** Thin git helpers used by the fleet (worktrees, merges, branch state). */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RangeDots } from "./types.ts";

export interface CommitRange {
  base: string;
  dots: RangeDots;
  head: string;
}

export function parseCommitRange(over?: string): CommitRange | undefined {
  if (!over) return undefined;
  const match = /^(.*?)(\.{2,3})(.+)$/.exec(over);
  if (!match) return undefined;
  const [, base, dots, head] = match;
  if (!base || !head || base.endsWith(".") || head.startsWith(".")) return undefined;
  return { base, dots: dots as RangeDots, head };
}

const pExecFile = promisify(execFile);

async function gitRaw(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await pExecFile("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.replace(/[\r\n]+$/, "");
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitRaw(cwd, ...args)).trim();
}

function extractGitError(err: any): string {
  for (const candidate of [err?.stderr, err?.stdout, err?.message]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return String(err);
}

export async function tryGit(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, ...args) };
  } catch (err: any) {
    return { ok: false, out: extractGitError(err) };
  }
}

async function tryGitRaw(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await gitRaw(cwd, ...args) };
  } catch (err: any) {
    return { ok: false, out: extractGitError(err) };
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "--show-toplevel");
}

export async function headRev(cwd: string, ref = "HEAD"): Promise<string> {
  if (ref.startsWith("-")) {
    throw new Error(`invalid git ref '${ref}'`);
  }
  return git(cwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
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
  const alreadyMerging = (await tryGit(root, "rev-parse", "--verify", "-q", "MERGE_HEAD")).ok;
  const r = await tryGit(root, "merge", "--no-ff", branch, "-m", message);
  if (r.ok) return { ok: true, conflicts: [], output: r.out };
  const nowMerging = (await tryGit(root, "rev-parse", "--verify", "-q", "MERGE_HEAD")).ok;
  let conflicts: string[] = [];
  if (!alreadyMerging && nowMerging) {
    const u = await tryGit(root, "diff", "--name-only", "--diff-filter=U");
    conflicts = u.ok ? u.out.split("\n").filter(Boolean) : [];
    await tryGit(root, "merge", "--abort");
  }
  return { ok: false, conflicts, output: r.out };
}

/** Diff stat between baseRef and branch (for review context). */
export async function diffForReview(
  root: string,
  baseRef: string,
  branch: string,
  dots: RangeDots = "...",
): Promise<string> {
  const range = `${baseRef}${dots}${branch}`;
  const stat = await tryGitRaw(root, "diff", "--stat", range);
  const diff = await tryGitRaw(root, "diff", range);
  return [stat.ok ? stat.out : "", diff.ok ? diff.out : ""].filter(Boolean).join("\n\n");
}
