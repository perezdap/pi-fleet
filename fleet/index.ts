/** pi-fleet extension entry.
 *
 * Orchestrates a fleet of pi coding agents in isolated git worktrees from a
 * single supervisor session. Zero runtime dependencies: only pi's extension API,
 * pi's own CLI in RPC mode, git, and Node built-ins.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Fleet,
  parseFleetCommand,
  toolParamsToCommand,
  type FleetUi,
  type NotifyLevel,
} from "./fleet.ts";
import { repoRoot } from "./gitw.ts";
import { ROLE_NAMES } from "./types.ts";

const OPTIONAL = Symbol("optional");

const Type = {
  Literal: (value: string) => ({ type: "string", const: value }),
  Union: (anyOf: unknown[], opts?: Record<string, unknown>) => ({ anyOf, ...opts }),
  String: (opts?: Record<string, unknown>) => ({ type: "string", ...opts }),
  Number: (opts?: Record<string, unknown>) => ({ type: "number", ...opts }),
  Boolean: (opts?: Record<string, unknown>) => ({ type: "boolean", ...opts }),
  Optional: <T extends Record<string, unknown>>(schema: T): T & { [OPTIONAL]?: true } =>
    ({ ...schema, [OPTIONAL]: true }),
  Object: (props: Record<string, any>) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(props)) {
      const { [OPTIONAL]: isOpt, ...rest } = v;
      properties[k] = rest;
      if (!isOpt) required.push(k);
    }
    return { type: "object", required, properties } as any;
  },
};

export default function (pi: ExtensionAPI) {
  const fleets = new Map<string, Fleet>();

  function makeUi(ctx: any): FleetUi {
    return {
      notify: (text: string, level: NotifyLevel = "info") => {
        try {
          ctx.ui.notify(text, level);
        } catch {
          // print mode: no UI
        }
      },
      setWidget: (lines: string[]) => {
        try {
          ctx.ui.setWidget("fleet", lines);
        } catch {
          // best-effort
        }
      },
    };
  }

  async function getFleet(ctx: any): Promise<Fleet> {
    const root = await repoRoot(ctx.cwd);
    let fleet = fleets.get(root);
    if (!fleet) {
      fleet = new Fleet(root, makeUi(ctx));
      fleets.set(root, fleet);
    } else {
      fleet.ui = makeUi(ctx); // rebind to the freshest UI context
    }
    return fleet;
  }

  function fail(ctx: any, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      ctx.ui.notify(`fleet: ${msg}`, "error");
    } catch {
      // no UI available
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      const fleet = await getFleet(ctx);
      await fleet.reconcile();
    } catch {
      // Not a git repository: nothing to reconcile.
    }
  });

  pi.on("session_shutdown", async () => {
    // Detach without killing: member state lives on disk (manifest, branches).
    for (const fleet of fleets.values()) fleet.dispose();
  });

  // ── /fleet command adapter ────────────────────────────────────────────────

  pi.registerCommand("fleet", {
    description: "Manage a fleet of pi agents in isolated git worktrees",
    handler: async (args: string, ctx: any) => {
      try {
        const cmd = parseFleetCommand(args);
        const fleet = await getFleet(ctx);
        const { messages } = await fleet.execute(cmd);
        for (const m of messages) {
          ctx.ui.notify(m.text, m.level);
        }
      } catch (err) {
        fail(ctx, err);
      }
    },
  });

  // ── fleet tool adapter (LLM-facing) ───────────────────────────────────────

  pi.registerTool({
    name: "fleet",
    label: "Fleet",
    description:
      "Manage a fleet of pi agents working in isolated git worktrees of this repository. " +
      "spawn: start a member (role: coder|tester|reviewer|integrator; optionally set its model or base ref via over). " +
      "resume: continue a stale/stopped/failed/done member on its existing worktree. " +
      "status: list members. send: message a member. log: tail member activity. " +
      "merge: merge a member branch (or '--done') into HEAD. stop: abort+kill a member (or '--all'). " +
      "clean: remove worktree/branch for a member (or '--done' / '--all').",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("status"),
          Type.Literal("spawn"),
          Type.Literal("resume"),
          Type.Literal("send"),
          Type.Literal("log"),
          Type.Literal("merge"),
          Type.Literal("stop"),
          Type.Literal("clean"),
        ],
        { description: "Fleet action to perform" },
      ),
      name: Type.Optional(
        Type.String({
          description:
            "Member name (or '--done' for merge/clean, '--all' for stop/clean)",
        }),
      ),
      task: Type.Optional(Type.String({ description: "Full task description (spawn only)" })),
      role: Type.Optional(
        Type.Union(
          ROLE_NAMES.map((r) => Type.Literal(r)),
          { description: "Member role (spawn only, default coder)" },
        ),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model pattern for the member, e.g. anthropic/claude-opus-4-5:high (spawn only)",
        }),
      ),
      over: Type.Optional(
        Type.String({
          description: "Base branch/ref the worktree starts from (spawn only)",
        }),
      ),
      message: Type.Optional(
        Type.String({
          description: "Message text (send) or extra instructions (resume)",
        }),
      ),
      n: Type.Optional(
        Type.Number({
          description: "Number of activity log entries to tail (log only, default 20)",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Force worktree/branch removal even when attached or unmerged (clean only)",
        }),
      ),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: any) {
      try {
        const cmd = toolParamsToCommand(params);
        const fleet = await getFleet(ctx);
        const { messages } = await fleet.execute(cmd);
        return {
          content: [{ type: "text", text: messages.map((m) => m.text).join("\n") }],
          details: {},
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `fleet error: ${msg}` }], details: {}, isError: true };
      }
    },
  });
}
