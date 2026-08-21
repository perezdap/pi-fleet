/** Fleet configuration: loads .pi/fleet/config.json over built-in defaults. */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { FleetConfig, RoleName, RoleSpec } from "./types";

/** Built-in role defaults. Config entries merge over these. */
export const BUILTIN_ROLES: Record<RoleName, RoleSpec> = {
  coder: {},
  tester: {},
  // Enforced read-only: no write/edit/bash tools.
  reviewer: { tools: "read,grep,find,ls" },
  integrator: {},
};

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "fleet", "config.json");
}

export async function loadFleetConfig(repoRoot: string): Promise<FleetConfig> {
  let user: Partial<FleetConfig> = {};
  try {
    user = JSON.parse(await readFile(configPath(repoRoot), "utf8"));
  } catch {
    // No config file or unreadable: use defaults.
  }
  return {
    worktreeRoot: user.worktreeRoot ?? ".pi/fleet/wt",
    sessionDir: user.sessionDir ?? ".pi/fleet/sessions",
    logDir: user.logDir ?? ".pi/fleet/logs",
    maxMembers: user.maxMembers ?? 6,
    baseRef: user.baseRef ?? "HEAD",
    defaultRole: user.defaultRole ?? "coder",
    piBin: user.piBin,
    roles: user.roles ?? {},
  };
}

/** Merge built-in role defaults with config overrides. */
export function resolveRoleSpec(cfg: FleetConfig, role: RoleName): RoleSpec {
  return { ...BUILTIN_ROLES[role], ...(cfg.roles?.[role] ?? {}) };
}

export function piBinary(cfg: FleetConfig): string {
  return cfg.piBin ?? "pi";
}
