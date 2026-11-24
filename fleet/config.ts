/** Fleet configuration: loads .pi/fleet/config.json over built-in defaults. */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { ROLE_NAMES, type FleetConfig, type RoleName, type RoleSpec } from "./types.ts";

/** Built-in role defaults. Config entries merge over these. */
const BUILTIN_ROLES: Record<RoleName, RoleSpec> = {
  coder: {},
  tester: {},
  // Enforced read-only: no write/edit/bash tools.
  reviewer: { tools: "read,grep,find,ls", autoClean: true },
  integrator: {},
};

function configPath(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "fleet", "config.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadFleetConfig(
  repoRoot: string,
  onWarn?: (msg: string) => void,
): Promise<FleetConfig> {
  let user: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = await readFile(configPath(repoRoot), "utf8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      onWarn?.(`fleet: failed to read config (${err?.message ?? err}); using defaults`);
    }
  }
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        user = parsed;
      } else {
        onWarn?.("fleet: .pi/fleet/config.json must be a JSON object; using defaults");
      }
    } catch {
      onWarn?.("fleet: invalid JSON in .pi/fleet/config.json; using defaults");
    }
  }

  let maxMembers = 6;
  if (user.maxMembers !== undefined) {
    if (typeof user.maxMembers === "number" && Number.isInteger(user.maxMembers) && user.maxMembers >= 1) {
      maxMembers = user.maxMembers;
    } else {
      onWarn?.("fleet: config maxMembers must be a positive integer; using 6");
    }
  }

  let defaultRole: RoleName = "coder";
  if (user.defaultRole !== undefined) {
    if (typeof user.defaultRole === "string" && ROLE_NAMES.includes(user.defaultRole as RoleName)) {
      defaultRole = user.defaultRole as RoleName;
    } else {
      onWarn?.(`fleet: config defaultRole '${String(user.defaultRole)}' is invalid; using coder`);
    }
  }

  let roles: Partial<Record<RoleName, RoleSpec>> = {};
  if (user.roles !== undefined) {
    if (isPlainObject(user.roles)) {
      roles = user.roles as Partial<Record<RoleName, RoleSpec>>;
    } else {
      onWarn?.("fleet: config roles must be an object; ignoring");
    }
  }

  const optStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

  return {
    worktreeRoot: optStr(user.worktreeRoot) ?? ".pi/fleet/wt",
    sessionDir: optStr(user.sessionDir) ?? ".pi/fleet/sessions",
    logDir: optStr(user.logDir) ?? ".pi/fleet/logs",
    maxMembers,
    baseRef: optStr(user.baseRef) ?? "HEAD",
    defaultRole,
    piBin: optStr(user.piBin),
    roles,
  };
}

/** Merge built-in role defaults with config overrides. */
export function resolveRoleSpec(cfg: FleetConfig, role: RoleName): RoleSpec {
  return { ...BUILTIN_ROLES[role], ...(cfg.roles?.[role] ?? {}) };
}

export function piBinary(cfg: FleetConfig): string {
  return cfg.piBin ?? "pi";
}
