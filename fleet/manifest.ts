/** Manifest persistence: the disk-truth registry of fleet members. */

import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Manifest, MemberStatus } from "./types.ts";

export function fleetDir(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "fleet");
}

function manifestPath(repoRoot: string): string {
  return path.join(fleetDir(repoRoot), "manifest.json");
}

let tmpSeq = 0;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadManifest(
  repoRoot: string,
  onWarn?: (msg: string) => void,
): Promise<Manifest> {
  const file = manifestPath(repoRoot);
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      onWarn?.(`fleet: failed to read manifest.json (${err?.message ?? err}); starting fresh`);
    }
    return { version: 1, repoRoot, members: {} };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed) && parsed.version === 1 && isPlainObject(parsed.members)) {
      return { ...(parsed as unknown as Manifest), repoRoot };
    }
  } catch {
    // Invalid JSON falls through to backup and fresh manifest.
  }

  const backup = `${file}.corrupt.${Date.now()}`;
  await copyFile(file, backup).catch(() => undefined);
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
