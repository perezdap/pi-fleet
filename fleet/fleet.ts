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
import { loadFleetConfig, piBinary, resolveRoleSpec } from "./config";
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
} from "./gitw";
import { fleetDir, isActiveStatus, isPidAlive, loadManifest, saveManifest } from "./manifest";
import { buildSystemAppend, resumePreamble } from "./roles";
import { RpcMember } from "./rpc";
import type { FleetConfig, Manifest, Member, RoleName } from "./types";

export type NotifyLevel = "info" | "warn" | "error";

export interface FleetUi {
  notify(text: string, level?: NotifyLevel): void;
  setWidget(lines: string[]): void;
}

export interface SpawnOptions {
  name: string;
  task: string;
  role?: RoleName;
  /** Model override, e.g. "anthropic/claude-opus-4-5:high". */
  model?: string;
  /** Branch/ref the worktree starts from (default: config baseRef). */
  over?: string;
}

export interface StatusRow {
  member: Member;
  live: boolean;
  busy: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const RESUMABLE = new Set(["stale", "stopped", "failed", "done"]);

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
  private clients = new Map<string, RpcMember>();
  private askWatchers = new Map<string, FSWatcher>();
  private cfg?: FleetConfig;
  private man?: Manifest;

  constructor(
    readonly root: string,
    public ui: FleetUi,
  ) {}

  // ── state ────────────────────────────────────────────────────────────────

  async config(): Promise<FleetConfig> {
    return (this.cfg ??= await loadFleetConfig(this.root));
  }

  async manifest(): Promise<Manifest> {
    this.man ??= await loadManifest(this.root);
    return this.man;
  }

  private async save(): Promise<void> {
    if (this.man) {
      await saveManifest(this.man);
      await this.refreshWidget();
    }
  }

  member(name: string): Member | undefined {
    return this.man?.members[name];
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
        if (await branchExists(this.root, branch)) await attachWorktree(this.root, wt, branch);
        else throw new Error(`cannot resume '${o.name}': worktree and branch are gone; run /fleet clean ${o.name} first`);
      }
      baseRef = existing!.baseRef;
    } else {
      baseRef = await headRev(this.root, baseInput);
      await addWorktree(this.root, wt, branch, baseRef);
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
      const promptsDir = path.join(fleetDir(this.root), "prompts");
      await mkdir(promptsDir, { recursive: true });
      const promptFile = path.join(promptsDir, `${o.name}.md`);
      await writeFile(
        promptFile,
        buildSystemAppend(
          { name: o.name, role, branch, repoRoot: this.root, task: member.task },
          spec.systemAppend,
        ),
        "utf8",
      );

      // Reviewers get the diff under review dropped into their worktree.
      if (role === "reviewer" && o.over) {
        await this.writeReviewContext(member, o.over);
      }

      const sessionDir = path.join(this.root, cfg.sessionDir ?? ".pi/fleet/sessions");
      await mkdir(sessionDir, { recursive: true });
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

      const client = await RpcMember.create({
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

      const firstMessage = resume ? resumePreamble(member) : member.task;
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
    const commits = await commitsSince(this.root, diffBase, target).catch(() => [] as string[]);
    const diff = await diffForReview(this.root, diffBase, target);
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
      const r = await removeWorktree(this.root, member.worktree, force);
      if (!r.ok) throw new Error(`worktree remove failed: ${r.out}`);
    }
    const merged = await branchMerged(this.root, member.branch).catch(() => false);
    if (merged || force) {
      const r = await deleteBranch(this.root, member.branch, force);
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
    const result = await mergeBranch(this.root, member.branch, `fleet(${name}): ${member.task.split("\n")[0]}`);
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

  async statusRows(): Promise<StatusRow[]> {
    const man = await this.manifest();
    const rows: StatusRow[] = [];
    for (const member of Object.values(man.members)) {
      const client = this.clients.get(member.name);
      rows.push({ member, live: !!client && !client.exited, busy: !!client?.busy });
    }
    rows.sort((a, b) => a.member.createdAt - b.member.createdAt);
    return rows;
  }

  widgetLines(rows: StatusRow[]): string[] {
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

  async refreshWidget(): Promise<void> {
    try {
      const rows = await this.statusRows();
      this.ui.setWidget(this.widgetLines(rows));
    } catch {
      // Widget is best-effort.
    }
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
