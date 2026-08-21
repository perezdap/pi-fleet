/** pi-fleet extension entry point.
 *
 * Registers:
 *  - /fleet command (human-driven fleet management)
 *  - `fleet` tool (so the supervisor LLM can orchestrate members itself)
 *
 * Zero runtime dependencies: only pi's extension API, pi's own CLI in RPC
 * mode, git, and Node built-ins.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Fleet, type FleetUi, type NotifyLevel } from "./fleet";
import { repoRoot } from "./gitw";
import { ROLE_NAMES, type RoleName } from "./types";

const USAGE = [
  "/fleet — run parallel pi agents in isolated git worktrees",
  "  status                          Show all members",
  "  spawn [--role r] [--model m] [--over ref] <name> <task…>",
  "  resume <name> [extra…]          Continue a stale/stopped member",
  "  send <name> <message…>          Steer or prompt a member",
  "  log <name> [n]                  Tail a member's activity log",
  "  merge <name|--done>             Merge a member branch into HEAD",
  "  stop <name|--all>               Abort + kill member process(es)",
  "  clean <name|--done|--all> [--force]  Remove worktree (+branch if merged)",
  "  open <name>                     Resume member session in a new pi window",
  "Roles: coder, tester, reviewer (read-only), integrator — see README.",
].join("\n");

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

  // ── /fleet command ────────────────────────────────────────────────────────

  pi.registerCommand("fleet", {
    description: "Manage a fleet of pi agents in isolated git worktrees",
    handler: async (args: string, ctx: any) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "status";
      try {
        const fleet = await getFleet(ctx);
        switch (sub) {
          case "help":
          case "--help":
          case "-h":
            ctx.ui.notify(USAGE, "info");
            break;

          case "status": {
            const rows = await fleet.statusRows();
            if (rows.length === 0) {
              ctx.ui.notify("fleet: no members; try /fleet spawn <name> <task>", "info");
              break;
            }
            for (const line of fleet.widgetLines(rows)) ctx.ui.notify(line, "info");
            await fleet.refreshWidget();
            break;
          }

          case "spawn": {
            const { name, task, role, model, over } = parseSpawn(tokens.slice(1));
            if (!name || !task) {
              ctx.ui.notify("usage: /fleet spawn [--role r] [--model m] [--over ref] <name> <task…>", "error");
              break;
            }
            const member = await fleet.spawn({ name, task, role, model, over });
            ctx.ui.notify(`fleet: spawned '${member.name}' (${member.role}) on ${member.branch}`, "info");
            break;
          }

          case "resume": {
            const name = tokens[1];
            if (!name) throw new Error("usage: /fleet resume <name> [extra instructions…]");
            const member = fleet.member(name) ?? (await fleet.manifest()).members[name];
            if (!member) throw new Error(`no such member '${name}'`);
            const extra = tokens.slice(2).join(" ");
            const task = extra ? `${member.task}\n\nAdditional instructions from supervisor:\n${extra}` : member.task;
            const resumed = await fleet.spawn({ name, task, role: member.role, model: member.model });
            ctx.ui.notify(`fleet: resumed '${resumed.name}'`, "info");
            break;
          }

          case "send": {
            const name = tokens[1];
            const message = tokens.slice(2).join(" ");
            if (!name || !message) throw new Error("usage: /fleet send <name> <message…>");
            const mode = await fleet.send(name, message);
            ctx.ui.notify(`fleet: sent to '${name}' (${mode})`, "info");
            break;
          }

          case "log": {
            const name = tokens[1];
            if (!name) throw new Error("usage: /fleet log <name> [n]");
            const n = Number(tokens[2] ?? 20);
            const text = await fleet.logTail(name, Number.isFinite(n) && n > 0 ? n : 20);
            for (const line of text.split("\n")) ctx.ui.notify(line, "info");
            break;
          }

          case "merge": {
            const which = tokens[1];
            if (!which) throw new Error("usage: /fleet merge <name|--done>");
            const man = await fleet.manifest();
            const names =
              which === "--done"
                ? Object.values(man.members).filter((m) => m.status === "done").map((m) => m.name)
                : [which];
            if (names.length === 0) throw new Error("no members with status 'done' to merge");
            for (const name of names) {
              const result = await fleet.merge(name);
              if (result.ok) ctx.ui.notify(`fleet: merged ${name}`, "info");
              else {
                ctx.ui.notify(`fleet: merge ${name} CONFLICTS in: ${result.conflicts.join(", ") || "(unknown)"}`, "error");
              }
            }
            break;
          }

          case "stop": {
            const which = tokens[1];
            if (!which) throw new Error("usage: /fleet stop <name|--all>");
            const man = await fleet.manifest();
            const names = which === "--all" ? Object.keys(man.members) : [which];
            for (const name of names) {
              await fleet.stop(name);
              ctx.ui.notify(`fleet: stopped '${name}'`, "info");
            }
            break;
          }

          case "clean": {
            const force = tokens.includes("--force");
            const positional = tokens.slice(1).filter((t) => !t.startsWith("--"));
            const which = positional[0];
            if (!which) throw new Error("usage: /fleet clean <name|--done|--all> [--force]");
            const man = await fleet.manifest();
            const names =
              which === "--all"
                ? Object.keys(man.members)
                : which === "--done"
                  ? Object.values(man.members)
                      .filter((m) => ["done", "merged", "failed", "stopped", "stale"].includes(m.status))
                      .map((m) => m.name)
                  : [which];
            for (const name of names) {
              const outcome = await fleet.clean(name, force);
              ctx.ui.notify(`fleet: cleaned '${name}' (${outcome})`, "info");
            }
            break;
          }

          case "open": {
            const name = tokens[1];
            if (!name) throw new Error("usage: /fleet open <name>");
            const outcome = await fleet.open(name);
            ctx.ui.notify(`fleet: ${outcome}`, "info");
            break;
          }

          default:
            ctx.ui.notify(USAGE, "info");
        }
      } catch (err) {
        fail(ctx, err);
      }
    },
  });

  // ── fleet tool (LLM-facing) ───────────────────────────────────────────────

  pi.registerTool({
    name: "fleet",
    label: "Fleet",
    description:
      "Manage a fleet of pi agents working in isolated git worktrees of this repository. " +
      "spawn: start a member (role: coder|tester|reviewer|integrator; optionally set its model). " +
      "status: list members. send: message a member. log: tail member activity. " +
      "merge: merge a member branch into HEAD. stop: abort+kill a member. clean: remove worktree/branch.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("status"),
          Type.Literal("spawn"),
          Type.Literal("send"),
          Type.Literal("log"),
          Type.Literal("merge"),
          Type.Literal("stop"),
          Type.Literal("clean"),
        ],
        { description: "Fleet action to perform" },
      ),
      name: Type.Optional(Type.String({ description: "Member name (required for send/log/merge/stop/clean and spawn)" })),
      task: Type.Optional(Type.String({ description: "Full task description (spawn only)" })),
      role: Type.Optional(
        Type.Union(ROLE_NAMES.map((r) => Type.Literal(r)), { description: "Member role (spawn only, default coder)" }),
      ),
      model: Type.Optional(Type.String({ description: "Model pattern for the member, e.g. anthropic/claude-opus-4-5:high (spawn only)" })),
      message: Type.Optional(Type.String({ description: "Message text (send only)" })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: any) {
      const lines: string[] = [];
      try {
        const fleet = await getFleet(ctx);
        switch (params.action) {
          case "status": {
            const rows = await fleet.statusRows();
            if (rows.length === 0) lines.push("No fleet members.");
            for (const { member, live, busy } of rows) {
              lines.push(
                `${member.name} [${member.role}] status=${member.status}${busy ? " (busy)" : ""}${live ? "" : " (not attached)"} branch=${member.branch}` +
                  (member.needsAttention ? ` ASK: ${member.needsAttention}` : ""),
              );
            }
            await fleet.refreshWidget();
            break;
          }
          case "spawn": {
            if (!params.name || !params.task) throw new Error("spawn requires name and task");
            const member = await fleet.spawn({
              name: params.name,
              task: params.task,
              role: params.role as RoleName | undefined,
              model: params.model,
            });
            lines.push(`Spawned '${member.name}' (${member.role}) on branch ${member.branch}.`);
            break;
          }
          case "send": {
            if (!params.name || !params.message) throw new Error("send requires name and message");
            const mode = await fleet.send(params.name, params.message);
            lines.push(`Message delivered to '${params.name}' via ${mode}.`);
            break;
          }
          case "log": {
            if (!params.name) throw new Error("log requires name");
            lines.push(await fleet.logTail(params.name));
            break;
          }
          case "merge": {
            if (!params.name) throw new Error("merge requires name");
            const result = await fleet.merge(params.name);
            lines.push(
              result.ok
                ? `Merged ${params.name} into HEAD.`
                : `Merge of ${params.name} had conflicts: ${result.conflicts.join(", ")}. Merge aborted; resolve manually or assign an integrator.`,
            );
            break;
          }
          case "stop": {
            if (!params.name) throw new Error("stop requires name");
            await fleet.stop(params.name);
            lines.push(`Stopped '${params.name}'.`);
            break;
          }
          case "clean": {
            if (!params.name) throw new Error("clean requires name");
            lines.push(`Cleaned '${params.name}': ${await fleet.clean(params.name)}`);
            break;
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `fleet error: ${msg}` }], details: {}, isError: true };
      }
    },
  });
}

// ── argument parsing ─────────────────────────────────────────────────────────

function parseSpawn(tokens: string[]): {
  name?: string;
  task: string;
  role?: RoleName;
  model?: string;
  over?: string;
} {
  const opts: { role?: RoleName; model?: string; over?: string } = {};
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--role" && tokens[i + 1]) {
      const role = tokens[i + 1] as RoleName;
      if (ROLE_NAMES.includes(role)) opts.role = role;
      i += 2;
    } else if (t === "--model" && tokens[i + 1]) {
      opts.model = tokens[i + 1];
      i += 2;
    } else if (t === "--over" && tokens[i + 1]) {
      opts.over = tokens[i + 1];
      i += 2;
    } else {
      break;
    }
  }
  return {
    name: tokens[i],
    task: tokens.slice(i + 1).join(" "),
    ...opts,
  };
}
