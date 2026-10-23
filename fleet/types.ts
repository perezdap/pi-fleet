/** Shared types for pi-fleet. */

export type RoleName = "coder" | "tester" | "reviewer" | "integrator";

export const ROLE_NAMES: RoleName[] = ["coder", "tester", "reviewer", "integrator"];

/** Role specification. All fields optional; merged over built-in defaults. */
export interface RoleSpec {
  /** Model pattern passed to the member's `pi --model`, e.g. "anthropic/claude-opus-4-5:high". */
  model?: string;
  /** Thinking level when no model-embedded ":level" is used. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Comma-separated tool allowlist, e.g. "read,grep,find,ls" for read-only reviewers. */
  tools?: string;
  /** Extra role-specific instructions appended to the fleet contract. */
  systemAppend?: string;
}

export interface FleetConfig {
  /** Override pi executable (default: "pi" resolved from PATH). */
  piBin?: string;
  /** Worktree root relative to repo root. Default ".pi/fleet/wt". */
  worktreeRoot?: string;
  /** Member session storage dir relative to repo root. Default ".pi/fleet/sessions". */
  sessionDir?: string;
  /** RPC event log dir relative to repo root. Default ".pi/fleet/logs". */
  logDir?: string;
  /** Max simultaneously running members. Default 6. */
  maxMembers?: number;
  /** Base ref for new worktrees. Default "HEAD". */
  baseRef?: string;
  /** Default role when spawn does not specify one. Default "coder". */
  defaultRole?: RoleName;
  /** Role overrides/extension. */
  roles?: Partial<Record<RoleName, RoleSpec>>;
}

export type MemberStatus =
  | "starting"
  | "running"
  | "idle"
  | "done"
  | "failed"
  | "stopped"
  | "detached"
  | "stale"
  | "merged";

export interface Member {
  name: string;
  role: RoleName;
  task: string;
  branch: string;
  /** Absolute path to the member's git worktree. */
  worktree: string;
  /** Commit the branch was created from. */
  baseRef: string;
  model?: string;
  pid?: number;
  sessionFile?: string;
  status: MemberStatus;
  /** First line of FLEET_ASK.md if the member raised a question. */
  needsAttention?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Manifest {
  version: 1;
  repoRoot: string;
  members: Record<string, Member>;
}

export type NotifyLevel = "info" | "warn" | "error";

export type MergeTarget =
  | { kind: "member"; name: string }
  | { kind: "done" };

export type StopTarget =
  | { kind: "member"; name: string }
  | { kind: "all" };

export type CleanTarget =
  | { kind: "member"; name: string }
  | { kind: "done" }
  | { kind: "all" };

export type FleetCommand =
  | { action: "help" }
  | { action: "status" }
  | {
      action: "spawn";
      name: string;
      task: string;
      role?: RoleName;
      model?: string;
      over?: string;
    }
  | {
      action: "resume";
      name: string;
      extra?: string;
    }
  | {
      action: "send";
      name: string;
      message: string;
    }
  | {
      action: "log";
      name: string;
      n?: number;
    }
  | {
      action: "merge";
      target: MergeTarget;
    }
  | {
      action: "stop";
      target: StopTarget;
    }
  | {
      action: "clean";
      target: CleanTarget;
      force?: boolean;
    }
  | {
      action: "open";
      name: string;
    };

export interface FleetMessage {
  text: string;
  level: NotifyLevel;
}

export interface FleetResult {
  messages: FleetMessage[];
}
