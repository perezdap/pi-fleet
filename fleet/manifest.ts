/** Manifest persistence: the disk-truth registry of fleet members. */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Manifest } from "./types.ts";

export function fleetDir(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "fleet");
}

export function manifestPath(repoRoot: string): string {
  return path.join(fleetDir(repoRoot), "manifest.json");
}

export async function loadManifest(repoRoot: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(repoRoot), "utf8"));
    if (parsed?.version === 1 && parsed.members) return parsed as Manifest;
  } catch {
    // Missing or corrupt: fall through to a fresh manifest.
  }
  return { version: 1, repoRoot, members: {} };
}

let tmpSeq = 0;
const saveQueues = new Map<string, Promise<void>>();

/** Atomic write: tmp file + rename. */
export async function saveManifest(manifest: Manifest): Promise<void> {
  const dir = fleetDir(manifest.repoRoot);
  const target = manifestPath(manifest.repoRoot);
  const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
  const prev = saveQueues.get(target) ?? Promise.resolve();
  const op = prev.then(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
    await rename(tmp, target);
  });
  saveQueues.set(
    target,
    op.catch(() => undefined),
  );
  await op;
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

export function isActiveStatus(status: string): boolean {
  return ["starting", "running", "idle"].includes(status);
}
