/** Fleet configuration: loads .pi/fleet/config.json over built-in defaults. */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  isPlainObject,
  ROLE_NAMES,
  THINKING_LEVELS,
  type FleetConfig,
  type RoleName,
  type RoleSpec,
  type ThinkingLevel,
} from "./types.ts";

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

function sanitizeRoleSpec(
  role: RoleName,
  raw: unknown,
  onWarn?: (msg: string) => void,
): RoleSpec | undefined {
  if (!isPlainObject(raw)) {
    onWarn?.(`fleet: config roles.${role} must be an object; ignoring`);
    return undefined;
  }
  const spec: RoleSpec = {};
  if (raw.model !== undefined) {
    if (typeof raw.model === "string" && raw.model.trim().length > 0) {
      spec.model = raw.model;
    } else {
      onWarn?.(`fleet: config roles.${role}.model must be a non-empty string; ignoring`);
    }
  }
  if (raw.thinking !== undefined) {
    if (typeof raw.thinking === "string" && THINKING_LEVELS.includes(raw.thinking as ThinkingLevel)) {
      spec.thinking = raw.thinking as ThinkingLevel;
    } else {
      onWarn?.(`fleet: config roles.${role}.thinking '${String(raw.thinking)}' is invalid; ignoring`);
    }
  }
  if (raw.tools !== undefined) {
    if (typeof raw.tools === "string") {
      spec.tools = raw.tools;
    } else {
      onWarn?.(`fleet: config roles.${role}.tools must be a string; ignoring`);
    }
  }
  if (raw.systemAppend !== undefined) {
    if (typeof raw.systemAppend === "string") {
      spec.systemAppend = raw.systemAppend;
    } else {
      onWarn?.(`fleet: config roles.${role}.systemAppend must be a string; ignoring`);
    }
  }
  if (raw.autoClean !== undefined) {
    if (typeof raw.autoClean === "boolean") {
      spec.autoClean = raw.autoClean;
    } else {
      onWarn?.(`fleet: config roles.${role}.autoClean must be a boolean; ignoring`);
    }
  }
  return spec;
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

  const roles: Partial<Record<RoleName, RoleSpec>> = {};
  if (user.roles !== undefined) {
    if (isPlainObject(user.roles)) {
      for (const [roleKey, rawRole] of Object.entries(user.roles)) {
        if (!ROLE_NAMES.includes(roleKey as RoleName)) {
          onWarn?.(`fleet: config roles.${roleKey} is not a known role; ignoring`);
          continue;
        }
        const role = roleKey as RoleName;
        const sanitized = sanitizeRoleSpec(role, rawRole, onWarn);
        if (sanitized) roles[role] = sanitized;
      }
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
  const rawOverride = cfg.roles?.[role];
  const override = rawOverride !== undefined ? (sanitizeRoleSpec(role, rawOverride) ?? {}) : {};
  return { ...BUILTIN_ROLES[role], ...override };
}

export function piBinary(cfg: FleetConfig): string {
  return cfg.piBin ?? "pi";
}
