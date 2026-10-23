/** Fleet controller: spawn, steer, watch, merge, and clean member agents.
 *
 * Members are headless `pi --mode rpc` processes, one per git worktree.
 * The manifest (.pi/fleet/manifest.json) is the disk-truth registry.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadFleetConfig, piBinary, resolveRoleSpec } from "./config.ts";
import {
  addWorktree,
  attachWorktree,
  branchExists,
  branchMerged,
  commitsSince,
  deleteBranch,
  diffForReview,
  headRev,
  mergeBranch,
  removeWorktree,
  type MergeResult,
} from "./gitw.ts";
import { fleetDir, isActiveStatus, isPidAlive, loadManifest, saveManifest } from "./manifest.ts";
import { buildSystemAppend, resumePreamble } from "./roles.ts";
import { RpcMember, type RpcEventHandler, type RpcSpawnOptions } from "./rpc.ts";
import {
  ROLE_NAMES,
  type FleetCommand,
  type FleetConfig,
  type FleetResult,
  type Manifest,
  type Member,
  type MemberStatus,
  type RoleName,
} from "./types.ts";

export type NotifyLevel = "info" | "warn" | "error";

export interface FleetUi {
  notify(text: string, level?: NotifyLevel): void;
  setWidget(lines: string[]): void;
}

export interface RpcClientLike {
  readonly pid: number;
  exited: boolean;
  busy: boolean;
  onEvent(handler: RpcEventHandler): () => void;
  waitReady(timeoutMs?: number): Promise<void>;
  getState(): Promise<any>;
  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<any>;
  steer(message: string): Promise<any>;
  abort(): Promise<any>;
  detach(): void;
  kill(): Promise<void>;
}

export interface FleetDeps {
  loadConfig: (root: string) => Promise<FleetConfig>;
  loadManifest: (root: string) => Promise<Manifest>;
  saveManifest: (man: Manifest) => Promise<void>;
  headRev: (root: string, ref?: string) => Promise<string>;
  addWorktree: (root: string, wt: string, branch: string, baseRef: string) => Promise<void>;
  attachWorktree: (root: string, wt: string, branch: string) => Promise<void>;
  removeWorktree: (root: string, wt: string, force?: boolean) => Promise<{ ok: boolean; out: string }>;
  deleteBranch: (root: string, branch: string, force?: boolean) => Promise<{ ok: boolean; out: string }>;
  branchExists: (root: string, branch: string) => Promise<boolean>;
  branchMerged: (root: string, branch: string) => Promise<boolean>;
  commitsSince: (root: string, baseRef: string, branch: string) => Promise<string[]>;
  diffForReview: (root: string, baseRef: string, branch: string) => Promise<string>;
  mergeBranch: (root: string, branch: string, message: string) => Promise<MergeResult>;
  createClient: (opts: RpcSpawnOptions) => Promise<RpcClientLike>;
  writePromptFile: (promptFile: string, content: string) => Promise<void>;
}

const DEFAULT_DEPS: FleetDeps = {
  loadConfig: loadFleetConfig,
  loadManifest,
  saveManifest,
  headRev,
  addWorktree,
  attachWorktree,
  removeWorktree,
  deleteBranch,
  branchExists,
  branchMerged,
  commitsSince,
  diffForReview,
  mergeBranch,
  createClient: async (opts) => {
    const idx = opts.args.indexOf("--session-dir");
    if (idx >= 0 && opts.args[idx + 1]) {
      await mkdir(opts.args[idx + 1], { recursive: true });
    }
    return RpcMember.create(opts);
  },
  writePromptFile: async (promptFile, content) => {
    await mkdir(path.dirname(promptFile), { recursive: true });
    await writeFile(promptFile, content, "utf8");
  },
};

export const USAGE = [
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

export interface SpawnOptions {
  name: string;
  task: string;
  role?: RoleName;
  /** Model override, e.g. "anthropic/claude-opus-4-5:high". */
  model?: string;
  /** Branch/ref the worktree starts from (default: config baseRef). */
  over?: string;
  /** Extra supervisor instructions on resume (does not overwrite member.task). */
  extra?: string;
}

export interface StatusRow {
  member: Member;
  live: boolean;
  busy: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const RESUMABLE = new Set<MemberStatus>(["stale", "stopped", "failed", "done"]);
const CLEANABLE_DONE = new Set<MemberStatus>(["done", "merged", "failed", "stopped", "stale"]);

const GLYPH: Record<Member["status"], string> = {
  starting: "…",
  running: "⚙",
  idle: "○",
  done: "✓",
  failed: "✗",
  stopped: "■",
  detached: "△",
  stale: "✗",
  merged: "✔",
};

export class Fleet {
  readonly root: string;
  public ui: FleetUi;

  private clients = new Map<string, RpcClientLike>();
  private askWatchers = new Map<string, FSWatcher>();
  private deps: FleetDeps;
  private cfg?: FleetConfig;
  private man?: Manifest;

  constructor(root: string, ui: FleetUi, deps?: Partial<FleetDeps>) {
    this.root = root;
    this.ui = ui;
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  // ── state ────────────────────────────────────────────────────────────────

  private async config(): Promise<FleetConfig> {
    return (this.cfg ??= await this.deps.loadConfig(this.root));
  }

  private async manifest(): Promise<Manifest> {
    this.man ??= await this.deps.loadManifest(this.root);
    return this.man;
  }

  private async save(): Promise<void> {
    if (this.man) {
      await this.deps.saveManifest(this.man);
      await this.refreshWidget();
    }
  }

  // ── command dispatch ─────────────────────────────────────────────────────

  async execute(cmd: FleetCommand): Promise<FleetResult> {
    switch (cmd.action) {
      case "help":
        return { lines: [USAGE] };

      case "status": {
        const rows = await this.statusRows();
        await this.refreshWidget();
        if (rows.length === 0) {
          return { lines: ["fleet: no members; try /fleet spawn <name> <task>"] };
        }
        return { lines: this.statusLines(rows) };
      }

      case "spawn": {
        const member = await this.spawn({
          name: cmd.name,
          task: cmd.task,
          role: cmd.role,
          model: cmd.model,
          over: cmd.over,
        });
        return { lines: [`fleet: spawned '${member.name}' (${member.role}) on ${member.branch}`] };
      }

      case "resume": {
        const resumed = await this.resume(cmd.name, cmd.extra);
        return { lines: [`fleet: resumed '${resumed.name}'`] };
      }

      case "send": {
        const mode = await this.send(cmd.name, cmd.message);
        return { lines: [`fleet: sent to '${cmd.name}' (${mode})`] };
      }

      case "log": {
        const text = await this.logTail(cmd.name, cmd.n ?? 20);
        return { lines: text.split("\n") };
      }

      case "merge": {
        const man = await this.manifest();
        const names =
          cmd.target === "--done"
            ? Object.values(man.members)
                .filter((m) => m.status === "done")
                .map((m) => m.name)
            : [cmd.target];
        if (cmd.target === "--done" && names.length === 0) {
          return { lines: ["fleet: no matching members to merge"] };
        }
        const lines: string[] = [];
        for (const name of names) {
          const result = await this.merge(name);
          if (result.ok) {
            lines.push(`fleet: merged ${name}`);
          } else {
            lines.push(
              `fleet: merge ${name} CONFLICTS in: ${result.conflicts.join(", ") || "(unknown)"}`,
            );
          }
        }
        return { lines };
      }

      case "stop": {
        const man = await this.manifest();
        const names =
          cmd.target === "--all"
            ? Object.values(man.members)
                .filter((m) => isActiveStatus(m.status) || this.clients.has(m.name))
                .map((m) => m.name)
            : [cmd.target];
        if (cmd.target === "--all" && names.length === 0) {
          return { lines: ["fleet: no matching members to stop"] };
        }
        const lines: string[] = [];
        for (const name of names) {
          await this.stop(name);
          lines.push(`fleet: stopped '${name}'`);
        }
        return { lines };
      }

      case "clean": {
        const force = !!cmd.force;
        const man = await this.manifest();
        const names =
          cmd.target === "--all"
            ? Object.keys(man.members)
            : cmd.target === "--done"
              ? Object.values(man.members)
                  .filter((m) => CLEANABLE_DONE.has(m.status))
                  .map((m) => m.name)
              : [cmd.target];
        if ((cmd.target === "--all" || cmd.target === "--done") && names.length === 0) {
          return { lines: ["fleet: no matching members to clean"] };
        }
        const lines: string[] = [];
        for (const name of names) {
          const outcome = await this.clean(name, force);
          lines.push(`fleet: cleaned '${name}' (${outcome})`);
        }
        return { lines };
      }

      case "open": {
        const outcome = await this.open(cmd.name);
        return { lines: [`fleet: ${outcome}`] };
      }
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async spawn(o: SpawnOptions): Promise<Member> {
    const cfg = await this.config();
    const man = await this.manifest();

    if (!NAME_RE.test(o.name)) {
      throw new Error(`invalid member name '${o.name}' (use lowercase letters, digits, dashes)`);
    }
    const existing = man.members[o.name];
    const resume = !!existing && RESUMABLE.has(existing.status);
    if (existing && !resume) {
      throw new Error(`member '${o.name}' already exists with status '${existing.status}'`);
    }

    const live = Object.values(man.members).filter((m) => isActiveStatus(m.status)).length;
    if (live >= (cfg.maxMembers ?? 6)) {
      throw new Error(`fleet is at max members (${cfg.maxMembers ?? 6}); stop or clean one first`);
    }

    const role: RoleName = o.role ?? (resume ? existing!.role : (cfg.defaultRole ?? "coder"));
    const spec = resolveRoleSpec(cfg, role);
    const model = o.model ?? spec.model;

    const branch = `fleet/${o.name}`;
    const wt = path.join(this.root, cfg.worktreeRoot ?? ".pi/fleet/wt", o.name);
    const baseInput = o.over ?? (resume ? existing!.baseRef : (cfg.baseRef ?? "HEAD"));
    let baseRef: string;

    if (resume) {
      // Reuse worktree if present; re-attach branch if the worktree was removed.
      if (!existsSync(wt)) {
        if (await this.deps.branchExists(this.root, branch)) await this.deps.attachWorktree(this.root, wt, branch);
        else throw new Error(`cannot resume '${o.name}': worktree and branch are gone; run /fleet clean ${o.name} first`);
      }
      baseRef = existing!.baseRef;
    } else {
      baseRef = await this.deps.headRev(this.root, baseInput);
      await this.deps.addWorktree(this.root, wt, branch, baseRef);
    }

    const now = Date.now();
    const member: Member = existing ?? {
      name: o.name,
      role,
      task: o.task,
      branch,
      worktree: wt,
      baseRef,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };
    if (resume) {
      member.task = o.task || member.task;
      member.model = model ?? member.model;
    } else {
      member.model = model;
    }
    member.status = "starting";
    member.needsAttention = undefined;
    member.updatedAt = now;
    man.members[o.name] = member;
    await this.save();

    try {
      // System prompt append lives in a file; pi reads file contents for --append-system-prompt.
      const promptFile = path.join(fleetDir(this.root), "prompts", `${o.name}.md`);
      const extraAppend = [spec.systemAppend, o.extra].filter(Boolean).join("\n\n");
      await this.deps.writePromptFile(
        promptFile,
        buildSystemAppend(
          { name: o.name, role, branch, repoRoot: this.root, task: member.task },
          extraAppend || undefined,
        ),
      );

      // Reviewers get the diff under review dropped into their worktree.
      if (role === "reviewer" && o.over) {
        await this.writeReviewContext(member, o.over);
      }

      const sessionDir = path.join(this.root, cfg.sessionDir ?? ".pi/fleet/sessions");
      const logFile = path.join(this.root, cfg.logDir ?? ".pi/fleet/logs", `${o.name}.jsonl`);

      const args = [
        // Worktrees are fresh directories: trust project-local files without prompting.
        "--approve",
        "--name", `fleet:${o.name}`,
        "--session-dir", sessionDir,
        "--append-system-prompt", promptFile,
      ];
      if (model) args.push("--model", model);
      else if (spec.thinking) args.push("--thinking", spec.thinking);
      if (spec.tools) args.push("--tools", spec.tools);

      const client = await this.deps.createClient({
        piBin: piBinary(cfg),
        cwd: wt,
        args,
        logFile,
      });
      this.clients.set(o.name, client);
      client.onEvent((ev) => void this.onMemberEvent(o.name, ev));
      this.watchAsk(member);

      await client.waitReady();
      const state = await client.getState().catch(() => undefined);
      member.pid = client.pid;
      member.sessionFile = state?.sessionFile ?? member.sessionFile;
      member.status = "running";
      member.updatedAt = Date.now();
      await this.save();

      const firstMessage = resume ? resumePreamble(member, o.extra) : member.task;
      await client.prompt(firstMessage);
      return member;
    } catch (err) {
      await this.stop(o.name).catch(() => undefined);
      member.status = "failed";
      member.updatedAt = Date.now();
      await this.save();
      throw err;
    }
  }

  private async writeReviewContext(member: Member, target: string): Promise<void> {
    const man = await this.manifest();
    const targetName = target.replace(/^fleet\//, "");
    const targetMember = man.members[targetName];
    const diffBase = targetMember?.baseRef ?? (await this.config()).baseRef ?? "HEAD";
    const commits = await this.deps.commitsSince(this.root, diffBase, target).catch(() => [] as string[]);
    const diff = await this.deps.diffForReview(this.root, diffBase, target);
    const dir = path.join(member.worktree, ".pi", "fleet");
    await mkdir(dir, { recursive: true });
    const commitList = commits.length ? commits.map((c) => `- ${c}`).join("\n") : "(no commits)";
    await writeFile(
      path.join(dir, "review-context.md"),
      `# Review context\n\nTarget: \`${target}\`\nDiff base: \`${diffBase}\`\n\n## Commits\n\n${commitList}\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n`,
      "utf8",
    );
  }

  async send(name: string, message: string): Promise<"steer" | "prompt"> {
    const client = this.mustClient(name);
    if (client.busy) {
      await client.steer(message);
      return "steer";
    }
    await client.prompt(message);
    return "prompt";
  }

  async stop(name: string): Promise<void> {
    const client = this.clients.get(name);
    const man = await this.manifest();
    const member = man.members[name];
    if (client) {
      await client.abort().catch(() => undefined);
      await client.kill();
      this.clients.delete(name);
      this.unwatchAsk(name);
    }
    if (member && isActiveStatus(member.status)) {
      member.status = "stopped";
      member.updatedAt = Date.now();
      await this.save();
    }
  }

  async clean(name: string, force = false): Promise<string> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) throw new Error(`no such member '${name}'`);
    if (this.clients.has(name)) {
      if (!force) throw new Error(`member '${name}' is still attached; run /fleet stop ${name} first`);
      await this.stop(name);
    }
    if (existsSync(member.worktree)) {
      const r = await this.deps.removeWorktree(this.root, member.worktree, force);
      if (!r.ok) throw new Error(`worktree remove failed: ${r.out}`);
    }
    const merged = await this.deps.branchMerged(this.root, member.branch).catch(() => false);
    if (merged || force) {
      const r = await this.deps.deleteBranch(this.root, member.branch, force);
      if (!r.ok && force) throw new Error(`branch delete failed: ${r.out}`);
    }
    delete man.members[name];
    await this.save();
    return merged ? "worktree removed, merged branch deleted" : "worktree removed, branch kept (unmerged)";
  }

  async merge(name: string): Promise<MergeResult> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) throw new Error(`no such member '${name}'`);
    const result = await this.deps.mergeBranch(this.root, member.branch, `fleet(${name}): ${member.task.split("\n")[0]}`);
    if (result.ok) {
      member.status = "merged";
      member.updatedAt = Date.now();
      await this.save();
    }
    return result;
  }

  /** Open a member's session in a new interactive pi window. */
  async open(name: string): Promise<string> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member?.sessionFile || !existsSync(member.sessionFile)) {
      throw new Error(`no resumable session recorded for '${name}'`);
    }
    const target = JSON.stringify(member.sessionFile);
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "cmd", "/k", `pi --session ${target}`], {
        cwd: member.worktree,
        windowsHide: true,
      });
    } else {
      const child = spawn("pi", ["--session", member.sessionFile], {
        cwd: member.worktree,
        detached: true,
        stdio: "inherit",
      });
      child.unref();
    }
    return `opened interactive pi for '${name}' in ${member.worktree}`;
  }

  // ── observation ──────────────────────────────────────────────────────────

  private async statusRows(): Promise<StatusRow[]> {
    const man = await this.manifest();
    const rows: StatusRow[] = [];
    for (const member of Object.values(man.members)) {
      const client = this.clients.get(member.name);
      rows.push({ member, live: !!client && !client.exited, busy: !!client?.busy });
    }
    rows.sort((a, b) => a.member.createdAt - b.member.createdAt);
    return rows;
  }

  private statusLines(rows: StatusRow[]): string[] {
    const active = rows.filter((r) => isActiveStatus(r.member.status)).length;
    const lines = [`fleet: ${rows.length} member${rows.length === 1 ? "" : "s"} (${active} active)`];
    for (const { member, live, busy } of rows) {
      const glyph = live ? GLYPH[member.status] : (member.status === "merged" ? "✔" : "·");
      const flags = `${busy ? " (busy)" : ""}${live ? "" : " (not attached)"}`;
      const ask = member.needsAttention ? ` ASK: ${member.needsAttention}` : "";
      lines.push(
        ` ${glyph} ${member.name} [${member.role}] status=${member.status}${flags} branch=${member.branch}${ask}`,
      );
    }
    return lines;
  }

  private widgetLines(rows: StatusRow[]): string[] {
    if (rows.length === 0) return [];
    const active = rows.filter((r) => isActiveStatus(r.member.status)).length;
    const lines = [`fleet: ${rows.length} member${rows.length === 1 ? "" : "s"} (${active} active)`];
    for (const { member, live } of rows.slice(0, 8)) {
      const glyph = live ? GLYPH[member.status] : (member.status === "merged" ? "✔" : "·");
      const ask = member.needsAttention ? `  ASK: ${truncate(member.needsAttention, 48)}` : "";
      lines.push(` ${glyph} ${member.name.padEnd(12)} ${member.role.padEnd(10)} ${member.status}${ask}`);
    }
    if (rows.length > 8) lines.push(` … ${rows.length - 8} more`);
    return lines;
  }

  private async refreshWidget(): Promise<void> {
    try {
      const rows = await this.statusRows();
      const lines = this.widgetLines(rows);
      if (lines.length > 0) this.ui.setWidget(lines);
    } catch {
      // Widget is best-effort.
    }
  }

  async resume(name: string, extra?: string): Promise<Member> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) throw new Error(`no such member '${name}'`);
    return this.spawn({
      name,
      task: member.task,
      role: member.role,
      model: member.model,
      extra,
    });
  }

  async logTail(name: string, n = 20): Promise<string> {
    const cfg = await this.config();
    const logFile = path.join(this.root, cfg.logDir ?? ".pi/fleet/logs", `${name}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(logFile, "utf8");
    } catch {
      return `(no log yet for '${name}')`;
    }
    const entries: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const text = extractText(ev.message).trim();
        if (text) entries.push(`assistant: ${truncate(text.replace(/\s+/g, " "), 220)}`);
      } else if (ev.type === "tool_execution_start") {
        entries.push(`tool: ${ev.toolName}`);
      }
    }
    const tail = entries.slice(-n);
    return tail.length ? tail.join("\n") : `(no activity logged for '${name}')`;
  }

  /** Re-check member processes after a supervisor restart. */
  async reconcile(): Promise<void> {
    const man = await this.manifest();
    let changed = false;
    for (const member of Object.values(man.members)) {
      if (!isActiveStatus(member.status)) continue;
      if (this.clients.has(member.name)) continue;
      const alive = isPidAlive(member.pid) && existsSync(member.worktree);
      member.status = alive ? "detached" : "stale";
      member.updatedAt = Date.now();
      changed = true;
      this.ui.notify(
        `fleet member '${member.name}' is ${member.status} after restart` +
          (member.status === "stale" ? "; /fleet resume to continue" : "; /fleet open or stop+clean"),
        "warn",
      );
    }
    if (changed) await this.save();
    else await this.refreshWidget();
  }

  /** Detach from all clients without killing them (used on session shutdown). */
  dispose(): void {
    for (const [name, client] of this.clients) {
      client.detach();
      this.unwatchAsk(name);
    }
    this.clients.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private mustClient(name: string): RpcMember {
    const client = this.clients.get(name);
    if (!client || client.exited) {
      throw new Error(`member '${name}' is not attached (status may be stale; try /fleet resume ${name})`);
    }
    return client;
  }

  private async onMemberEvent(name: string, ev: any): Promise<void> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) return;

    if (ev.type === "agent_start" && member.status !== "running") {
      member.status = "running";
      member.updatedAt = Date.now();
      await this.save();
    } else if (ev.type === "agent_end" && member.status === "running") {
      member.status = "idle";
      member.updatedAt = Date.now();
      await this.save();
    } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const text = extractText(ev.message);
      if (/^\s*DONE:/im.test(text.slice(0, 500))) {
        member.status = "done";
        member.updatedAt = Date.now();
        await this.save();
        this.ui.notify(`fleet member '${name}' reports DONE`, "info");
      }
    }
  }

  private watchAsk(member: Member): void {
    this.unwatchAsk(member.name);
    try {
      let timer: NodeJS.Timeout | undefined;
      const watcher = watch(member.worktree, (_event, filename) => {
        if (filename !== "FLEET_ASK.md") return;
        clearTimeout(timer);
        timer = setTimeout(() => void this.readAsk(member.name), 500);
      });
      this.askWatchers.set(member.name, watcher);
    } catch {
      // Watching is best-effort.
    }
  }

  private unwatchAsk(name: string): void {
    this.askWatchers.get(name)?.close();
    this.askWatchers.delete(name);
  }

  private async readAsk(name: string): Promise<void> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) return;
    try {
      const content = await readFile(path.join(member.worktree, "FLEET_ASK.md"), "utf8");
      const question = content.split("\n").map((l) => l.trim()).find(Boolean);
      if (question && question !== member.needsAttention) {
        member.needsAttention = question;
        member.updatedAt = Date.now();
        await this.save();
        this.ui.notify(`fleet member '${name}' asks: ${truncate(question, 120)}`, "warn");
      }
    } catch {
      // File removed: clear the flag.
      if (member.needsAttention) {
        member.needsAttention = undefined;
        await this.save();
      }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function extractText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function shiftToken(input: string): { token: string; rest: string } {
  const trimmed = input.trimStart();
  const match = /^(\S+)([\s\S]*)$/.exec(trimmed);
  if (!match) return { token: "", rest: "" };
  return { token: match[1], rest: match[2] ?? "" };
}

export function parseFleetCommand(raw: string): FleetCommand {
  const { token: sub, rest } = shiftToken(raw);
  if (!sub || sub === "status") return { action: "status" };
  if (sub === "help" || sub === "--help" || sub === "-h") return { action: "help" };

  switch (sub) {
    case "spawn": {
      const opts: { role?: RoleName; model?: string; over?: string } = {};
      let cursor = rest;
      let name = "";
      while (cursor.trimStart()) {
        const next = shiftToken(cursor);
        if (next.token === "--role") {
          const val = shiftToken(next.rest);
          if (!val.token || !ROLE_NAMES.includes(val.token as RoleName)) {
            throw new Error("usage: /fleet spawn [--role r] [--model m] [--over ref] <name> <task…>");
          }
          opts.role = val.token as RoleName;
          cursor = val.rest;
        } else if (next.token === "--model") {
          const val = shiftToken(next.rest);
          if (!val.token) {
            throw new Error("usage: /fleet spawn [--role r] [--model m] [--over ref] <name> <task…>");
          }
          opts.model = val.token;
          cursor = val.rest;
        } else if (next.token === "--over") {
          const val = shiftToken(next.rest);
          if (!val.token) {
            throw new Error("usage: /fleet spawn [--role r] [--model m] [--over ref] <name> <task…>");
          }
          opts.over = val.token;
          cursor = val.rest;
        } else if (next.token.startsWith("--")) {
          throw new Error("usage: /fleet spawn [--role r] [--model m] [--over ref] <name> <task…>");
        } else {
          name = next.token;
          cursor = next.rest;
          break;
        }
      }
      const task = unquote(cursor);
      if (!name || !task) {
        throw new Error("usage: /fleet spawn [--role r] [--model m] [--over ref] <name> <task…>");
      }
      return { action: "spawn", name, task, ...opts };
    }

    case "clean": {
      const tokens = rest.trim().split(/\s+/).filter(Boolean);
      let force = false;
      const targets: string[] = [];
      for (const t of tokens) {
        if (t === "--force") {
          force = true;
        } else if (t === "--done" || t === "--all" || !t.startsWith("--")) {
          targets.push(t);
        } else {
          throw new Error("usage: /fleet clean <name|--done|--all> [--force]");
        }
      }
      const target = targets[0];
      if (!target || targets.length > 1) {
        throw new Error("usage: /fleet clean <name|--done|--all> [--force]");
      }
      return { action: "clean", target, ...(force ? { force: true } : {}) };
    }

    case "resume": {
      const { token: name, rest: tail } = shiftToken(rest);
      if (!name) throw new Error("usage: /fleet resume <name> [extra instructions…]");
      const extra = unquote(tail);
      return { action: "resume", name, ...(extra ? { extra } : {}) };
    }

    case "send": {
      const { token: name, rest: tail } = shiftToken(rest);
      const message = unquote(tail);
      if (!name || !message) throw new Error("usage: /fleet send <name> <message…>");
      return { action: "send", name, message };
    }

    case "log": {
      const { token: name, rest: tail } = shiftToken(rest);
      if (!name) throw new Error("usage: /fleet log <name> [n]");
      const { token: nStr } = shiftToken(tail);
      const parsedN = nStr ? Number(nStr) : 20;
      const n = Number.isFinite(parsedN) && parsedN > 0 ? parsedN : 20;
      return { action: "log", name, n };
    }

    case "merge": {
      const { token: target, rest: tail } = shiftToken(rest);
      if (!target || shiftToken(tail).token || (target.startsWith("--") && target !== "--done")) {
        throw new Error("usage: /fleet merge <name|--done>");
      }
      return { action: "merge", target };
    }

    case "stop": {
      const { token: target, rest: tail } = shiftToken(rest);
      if (!target || shiftToken(tail).token || (target.startsWith("--") && target !== "--all")) {
        throw new Error("usage: /fleet stop <name|--all>");
      }
      return { action: "stop", target };
    }

    case "open": {
      const { token: name, rest: tail } = shiftToken(rest);
      if (!name || shiftToken(tail).token || name.startsWith("--")) {
        throw new Error("usage: /fleet open <name>");
      }
      return { action: "open", name };
    }

    default:
      return { action: "help" };
  }
}

export function toolParamsToCommand(params: {
  action: string;
  name?: string;
  task?: string;
  role?: RoleName;
  model?: string;
  over?: string;
  message?: string;
  n?: number;
  force?: boolean;
}): FleetCommand {
  switch (params.action) {
    case "status":
      return { action: "status" };
    case "spawn": {
      if (!params.name || !params.task) throw new Error("spawn requires name and task");
      return {
        action: "spawn",
        name: params.name,
        task: params.task,
        ...(params.role ? { role: params.role } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.over ? { over: params.over } : {}),
      };
    }
    case "resume": {
      if (!params.name) throw new Error("resume requires name");
      const extra = (params.message ?? params.task)?.trim();
      return {
        action: "resume",
        name: params.name,
        ...(extra ? { extra } : {}),
      };
    }
    case "send": {
      if (!params.name || !params.message) throw new Error("send requires name and message");
      return { action: "send", name: params.name, message: params.message };
    }
    case "log": {
      if (!params.name) throw new Error("log requires name");
      const n = typeof params.n === "number" && Number.isFinite(params.n) && params.n > 0 ? params.n : 20;
      return { action: "log", name: params.name, n };
    }
    case "merge": {
      if (!params.name) throw new Error("merge requires name (or '--done')");
      return { action: "merge", target: params.name };
    }
    case "stop": {
      if (!params.name) throw new Error("stop requires name (or '--all')");
      return { action: "stop", target: params.name };
    }
    case "clean": {
      if (!params.name) throw new Error("clean requires name (or '--done' / '--all')");
      return {
        action: "clean",
        target: params.name,
        ...(params.force ? { force: true } : {}),
      };
    }
    default:
      throw new Error(`unknown fleet action '${params.action}'`);
  }
}
