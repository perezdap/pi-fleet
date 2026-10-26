/** Manifest persistence: the disk-truth registry of fleet members. */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Manifest } from "./types.ts";

export function fleetDir(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "fleet");
}

export function manifestPath(repoRoot: string): string {
  return path.join(fleetDir(repoRoot), "manifest.json");
}

let tmpSeq = 0;

export async function loadManifest(repoRoot: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(repoRoot), "utf8"));
    if (parsed?.version === 1 && parsed.members) return parsed as Manifest;
  } catch {
    // Missing or corrupt: fall through to a fresh manifest.
  }
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

export function isActiveStatus(status: string): boolean {
  return ["starting", "running", "idle"].includes(status);
}
