/** Manifest persistence: the disk-truth registry of fleet members. */

import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  isPlainObject,
  isValidMemberName,
  MEMBER_STATUSES,
  ROLE_NAMES,
  type Manifest,
  type Member,
  type MemberStatus,
  type RoleName,
} from "./types.ts";

export function fleetDir(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "fleet");
}

function manifestPath(repoRoot: string): string {
  return path.join(fleetDir(repoRoot), "manifest.json");
}

let tmpSeq = 0;

function isOptString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isValidMember(key: string, value: unknown): value is Member {
  if (!isValidMemberName(key)) return false;
  if (!isPlainObject(value)) return false;
  if (typeof value.name !== "string" || !value.name || value.name !== key) return false;
  if (typeof value.role !== "string" || !ROLE_NAMES.includes(value.role as RoleName)) return false;
  if (typeof value.task !== "string") return false;
  if (typeof value.branch !== "string" || !value.branch) return false;
  if (typeof value.worktree !== "string" || !value.worktree) return false;
  if (typeof value.baseRef !== "string" || !value.baseRef) return false;
  if (typeof value.status !== "string" || !MEMBER_STATUSES.includes(value.status as MemberStatus)) {
    return false;
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return false;
  if (!isOptString(value.over)) return false;
  if (!isOptString(value.model)) return false;
  if (
    value.pid !== undefined &&
    (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0)
  ) {
    return false;
  }
  if (!isOptString(value.pidStartedAt)) return false;
  if (!isOptString(value.reviewContextSha256)) return false;
  if (!isOptString(value.sessionFile)) return false;
  if (!isOptString(value.needsAttention)) return false;
  if (!isOptString(value.result)) return false;
  if (value.transient !== undefined && typeof value.transient !== "boolean") return false;
  return true;
}

export function setOwnMember(members: Record<string, Member>, name: string, member: Member): void {
  Object.defineProperty(members, name, {
    value: member,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function partitionMembers(rawMembers: Record<string, unknown>): {
  members: Record<string, Member>;
  invalidKeys: string[];
} {
  const members: Record<string, Member> = {};
  const invalidKeys: string[] = [];
  for (const key of Object.getOwnPropertyNames(rawMembers)) {
    const value = rawMembers[key];
    if (!isValidMember(key, value)) {
      invalidKeys.push(key);
      continue;
    }
    setOwnMember(members, key, value);
  }
  return { members, invalidKeys };
}

async function backupCorruptManifest(
  file: string,
  doCopy: (src: string, dest: string) => Promise<void>,
): Promise<string> {
  const backup = `${file}.corrupt.${Date.now()}.${++tmpSeq}`;
  try {
    await doCopy(file, backup);
  } catch (err: any) {
    throw new Error(
      `fleet: invalid manifest.json and backup to ${path.basename(backup)} failed: ${err?.message ?? err}`,
      { cause: err },
    );
  }
  return backup;
}

export async function loadManifest(
  repoRoot: string,
  onWarn?: (msg: string) => void,
  opts?: { copyBackup?: (src: string, dest: string) => Promise<void> },
): Promise<Manifest> {
  const file = manifestPath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { version: 1, repoRoot, members: {} };
    }
    throw err;
  }

  const doCopy = opts?.copyBackup ?? copyFile;
  let parsed: unknown;
  let parsedOk = false;
  try {
    parsed = JSON.parse(raw);
    parsedOk = true;
  } catch {
    // Invalid JSON falls through to backup and fresh manifest.
  }

  if (parsedOk && isPlainObject(parsed) && parsed.version === 1 && isPlainObject(parsed.members)) {
    const { members, invalidKeys } = partitionMembers(parsed.members);
    if (invalidKeys.length === 0) {
      return { version: 1, repoRoot, members };
    }
    const backup = await backupCorruptManifest(file, doCopy);
    onWarn?.(
      `fleet: skipped invalid manifest member(s) (${invalidKeys.join(", ")}); backed up to ${path.basename(backup)}`,
    );
    return { version: 1, repoRoot, members };
  }

  const backup = await backupCorruptManifest(file, doCopy);
  onWarn?.(`fleet: invalid manifest.json; backed up to ${path.basename(backup)} and starting fresh`);
  return { version: 1, repoRoot, members: {} };
}

/** Atomic write: tmp file + rename. */
export async function saveManifest(manifest: Manifest): Promise<void> {
  const dir = fleetDir(manifest.repoRoot);
  await mkdir(dir, { recursive: true });
  const target = manifestPath(manifest.repoRoot);
  const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (err: any) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(err?.code) || attempt >= 4) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

export function isActiveStatus(status: MemberStatus): boolean {
  return ["starting", "running", "idle"].includes(status);
}
