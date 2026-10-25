import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseFleetCommand, toolParamsToCommand } from "./fleet.ts";
import { addWorktree, branchExists, git, headRev, mergeBranch } from "./gitw.ts";
import registerFleet from "./index.ts";
import { isPidAlive, loadManifest, saveManifest } from "./manifest.ts";
import type { Member, MemberStatus, NotifyLevel } from "./types.ts";

const FAKE_PI_SCRIPT = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    appendFileSync(path.join(process.cwd(), ".rpc-received.jsonl"), JSON.stringify(msg) + "\\n");
    if (msg.type === "get_state") {
      process.stdout.write(JSON.stringify({
        type: "response",
        id: msg.id,
        success: true,
        data: { sessionFile: path.join(process.cwd(), "session.json") },
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({
        type: "response",
        id: msg.id,
        success: true,
        data: {},
      }) + "\\n");
      const activeMsg =
        typeof msg.message === "string"
          ? msg.message.replace(/Original assignment:[\\s\\S]*?(?=\\n\\nAdditional instructions|$)/, "")
          : "";
      const parseTimedPayload = (prefix) => {
        const rest = activeMsg.slice(prefix.length);
        const colon = rest.indexOf(":");
        return { ms: Number(rest.slice(0, colon)), payload: rest.slice(colon + 1) };
      };
      if (msg.type === "prompt" && activeMsg.includes("FINISH_NOW")) {
        const customIdx = activeMsg.indexOf("FINISH_NOW:");
        const content =
          customIdx >= 0
            ? activeMsg.slice(customIdx + "FINISH_NOW:".length)
            : "DONE: finished work";
        process.stdout.write(JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content },
        }) + "\\n");
      } else if (msg.type === "prompt" && activeMsg.startsWith("DELAY_DONE:")) {
        const { ms, payload } = parseTimedPayload("DELAY_DONE:");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: payload },
          }) + "\\n");
        }, ms);
      } else if (msg.type === "prompt" && activeMsg.startsWith("WRITE_ASK:")) {
        const { ms, payload } = parseTimedPayload("WRITE_ASK:");
        setTimeout(() => {
          writeFileSync(path.join(process.cwd(), "FLEET_ASK.md"), payload + "\\n", "utf8");
        }, ms);
      } else if (msg.type === "prompt" && activeMsg.startsWith("EXIT_AFTER:")) {
        const { ms, payload } = parseTimedPayload("EXIT_AFTER:");
        setTimeout(() => {
          process.exit(Number(payload));
        }, ms);
      }
    }
  }
});
`;

interface TestHarness {
  root: string;
  notifications: Array<{ text: string; level: NotifyLevel }>;
  widgetLines: () => string[] | undefined;
  errors: () => string[];
  reconcileSession: () => Promise<void>;
  runCommand: (args: string) => Promise<void>;
  runTool: (params: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  seedMember: (
    name: string,
    status: MemberStatus,
    opts?: {
      task?: string;
      unmergedCommit?: boolean;
      mergedCommit?: boolean;
      conflictingCommit?: boolean;
      createdAt?: number;
      result?: string;
      needsAttention?: string;
    },
  ) => Promise<Member>;
  shutdown: () => Promise<void>;
  cleanup: () => Promise<void>;
}

async function createHarness(): Promise<TestHarness> {
  const rawRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-test-"));
  await git(rawRoot, "init", "-b", "main");
  await git(rawRoot, "config", "user.email", "test@example.com");
  await git(rawRoot, "config", "user.name", "Test User");
  await writeFile(path.join(rawRoot, "README.md"), "initial\n", "utf8");
  await git(rawRoot, "add", "README.md");
  await git(rawRoot, "commit", "-m", "initial");

  const root = await git(rawRoot, "rev-parse", "--show-toplevel");
  const baseRef = await headRev(root);

  const binDir = await mkdtemp(path.join(tmpdir(), "pi-fleet-bin-"));
  const mjsPath = path.join(binDir, "fake-pi.mjs");
  await writeFile(mjsPath, FAKE_PI_SCRIPT, "utf8");
  await chmod(mjsPath, 0o755);

  let piBin = mjsPath;
  if (process.platform === "win32") {
    const cmdPath = path.join(binDir, "fake-pi.cmd");
    await writeFile(cmdPath, `@node "%~dp0fake-pi.mjs" %*\r\n`, "utf8");
    piBin = cmdPath;
  }

  await mkdir(path.join(root, ".pi", "fleet"), { recursive: true });
  await writeFile(
    path.join(root, ".pi", "fleet", "config.json"),
    JSON.stringify({ piBin }),
    "utf8",
  );

  const notifications: Array<{ text: string; level: NotifyLevel }> = [];
  let currentWidget: string[] | undefined;
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let sessionStartHandler: ((event: any, ctx: any) => Promise<void>) | undefined;
  let toolExecutor:
    | ((id: string, params: any, sig: any, upd: any, ctx: any) => Promise<any>)
    | undefined;
  const shutdownHandlers: Array<() => Promise<void> | void> = [];

  function bindExtension(): void {
    shutdownHandlers.length = 0;
    const fakePi: any = {
      on: (event: string, fn: (event: any, ctx: any) => Promise<void> | void) => {
        if (event === "session_start") sessionStartHandler = fn;
        if (event === "session_shutdown") shutdownHandlers.push(fn);
      },
      registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) => {
        if (name === "fleet") commandHandler = spec.handler;
      },
      registerTool: (spec: { name: string; execute: any }) => {
        if (spec.name === "fleet") toolExecutor = spec.execute;
      },
    };
    registerFleet(fakePi);
  }
  bindExtension();

  const ctx = {
    cwd: root,
    ui: {
      notify: (text: string, level: NotifyLevel = "info") => {
        notifications.push({ text, level });
      },
      setWidget: (_id: string, lines: string[] | undefined) => {
        currentWidget = lines;
      },
    },
  };

  async function seedMember(
    name: string,
    status: MemberStatus,
    opts?: {
      task?: string;
      unmergedCommit?: boolean;
      mergedCommit?: boolean;
      conflictingCommit?: boolean;
      createdAt?: number;
      result?: string;
      needsAttention?: string;
    },
  ): Promise<Member> {
    const branch = `fleet/${name}`;
    const wt = path.join(root, ".pi", "fleet", "wt", name);
    await addWorktree(root, wt, branch, baseRef);

    if (opts?.conflictingCommit) {
      await writeFile(path.join(wt, "README.md"), `branch-${name}\n`, "utf8");
      await git(wt, "add", "README.md");
      await git(wt, "commit", "-m", `conflict by ${name}`);
      await writeFile(path.join(root, "README.md"), `main-change-against-${name}\n`, "utf8");
      await git(root, "add", "README.md");
      await git(root, "commit", "-m", `main change against ${name}`);
    } else if (opts?.unmergedCommit || opts?.mergedCommit) {
      await writeFile(path.join(wt, `${name}.txt`), `${name}\n`, "utf8");
      await git(wt, "add", `${name}.txt`);
      await git(wt, "commit", "-m", `work by ${name}`);
    }
    if (opts?.mergedCommit) {
      await mergeBranch(root, branch, `merge ${name}`);
    }

    const man = await loadManifest(root);
    const ts = opts?.createdAt ?? Date.now();
    const member: Member = {
      name,
      role: "coder",
      task: opts?.task ?? `task for ${name}`,
      branch,
      worktree: wt,
      baseRef,
      status,
      ...(opts?.result !== undefined ? { result: opts.result } : {}),
      ...(opts?.needsAttention !== undefined ? { needsAttention: opts.needsAttention } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    man.members[name] = member;
    await saveManifest(man);
    bindExtension();
    return member;
  }

  return {
    root,
    notifications,
    widgetLines: () => currentWidget,
    errors: () => notifications.filter((n) => n.level === "error").map((n) => n.text),
    reconcileSession: async () => {
      assert.ok(sessionStartHandler, "session_start handler must be registered");
      await sessionStartHandler({}, ctx);
    },
    runCommand: async (args: string) => {
      assert.ok(commandHandler);
      await commandHandler(args, ctx);
    },
    runTool: async (params: Record<string, unknown>) => {
      assert.ok(toolExecutor);
      const res = await toolExecutor("call-1", params, undefined, undefined, ctx);
      return {
        text: res.content.map((c: any) => c.text).join("\n"),
        isError: !!res.isError,
      };
    },
    seedMember,
    shutdown: async () => {
      for (const fn of shutdownHandlers) await fn();
    },
    cleanup: async () => {
      for (const fn of shutdownHandlers) await fn();
      await rm(rawRoot, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    },
  };
}

describe("parseFleetCommand", () => {
  it("parses empty input as status", () => {
    assert.deepEqual(parseFleetCommand(""), { action: "status" });
  });

  it("parses spawn with flags and strips outer quotes from task", () => {
    assert.deepEqual(
      parseFleetCommand('spawn --role reviewer --model openai/gpt-5 --over fleet/api r1 "Review the auth work"'),
      {
        action: "spawn",
        name: "r1",
        task: "Review the auth work",
        role: "reviewer",
        model: "openai/gpt-5",
        over: "fleet/api",
      },
    );
  });

  it("parses clean --done and --force in either flag order", () => {
    assert.deepEqual(parseFleetCommand("clean --force --done"), {
      action: "clean",
      target: { kind: "done" },
      force: true,
    });
  });

  it("parses resume with quoted extra instructions", () => {
    assert.deepEqual(parseFleetCommand('resume api "Finish validation tests"'), {
      action: "resume",
      name: "api",
      extra: "Finish validation tests",
    });
  });

  it("rejects missing required target on clean", () => {
    assert.throws(() => parseFleetCommand("clean --force"), /usage: \/fleet clean/);
  });

  it("parses wait with default all, --all, named members, --any, and --timeout in any order", () => {
    assert.deepEqual(
      {
        defaultAll: parseFleetCommand("wait"),
        explicitAll: parseFleetCommand("wait --all --any"),
        namedWithFlags: parseFleetCommand("wait --any --timeout 15 api ui"),
        flagsAfterTarget: parseFleetCommand("wait api --timeout 5 --any"),
      },
      {
        defaultAll: { action: "wait", target: { kind: "all" } },
        explicitAll: { action: "wait", target: { kind: "all" }, mode: "any" },
        namedWithFlags: {
          action: "wait",
          target: { kind: "members", names: ["api", "ui"] },
          mode: "any",
          timeout: 15,
        },
        flagsAfterTarget: {
          action: "wait",
          target: { kind: "members", names: ["api"] },
          mode: "any",
          timeout: 5,
        },
      },
    );
  });

  it("rejects invalid --timeout values, unknown flags, or mixing --all with names on wait", () => {
    const usageRe = /usage: \/fleet wait \[name\|--all\] \[--any\] \[--timeout <sec>\]/;
    assert.throws(() => parseFleetCommand("wait --timeout"), usageRe);
    assert.throws(() => parseFleetCommand("wait --timeout 0"), usageRe);
    assert.throws(() => parseFleetCommand("wait --timeout -5"), usageRe);
    assert.throws(() => parseFleetCommand("wait --timeout abc"), usageRe);
    assert.throws(() => parseFleetCommand("wait --bogus"), usageRe);
    assert.throws(() => parseFleetCommand("wait --all api"), usageRe);
  });
});

describe("toolParamsToCommand", () => {
  it("maps spawn parameters including over to a spawn command", () => {
    assert.deepEqual(
      toolParamsToCommand({
        action: "spawn",
        name: "rev1",
        task: "Review PR",
        role: "reviewer",
        over: "fleet/api",
      }),
      {
        action: "spawn",
        name: "rev1",
        task: "Review PR",
        role: "reviewer",
        over: "fleet/api",
      },
    );
  });

  it("maps resume message to extra instructions", () => {
    assert.deepEqual(
      toolParamsToCommand({
        action: "resume",
        name: "api",
        message: "Cover edge cases",
      }),
      {
        action: "resume",
        name: "api",
        extra: "Cover edge cases",
      },
    );
  });

  it("maps wait parameters for all, single name, and multiple names with mode and timeout", () => {
    assert.deepEqual(
      {
        allOmitted: toolParamsToCommand({ action: "wait" }),
        allExplicit: toolParamsToCommand({ action: "wait", name: "--all", mode: "any", timeout: 10 }),
        singleName: toolParamsToCommand({ action: "wait", name: "api" }),
        multipleNames: toolParamsToCommand({
          action: "wait",
          names: ["api", "ui"],
          mode: "any",
          timeout: 30,
        }),
      },
      {
        allOmitted: { action: "wait", target: { kind: "all" } },
        allExplicit: { action: "wait", target: { kind: "all" }, mode: "any", timeout: 10 },
        singleName: { action: "wait", target: { kind: "members", names: ["api"] } },
        multipleNames: {
          action: "wait",
          target: { kind: "members", names: ["api", "ui"] },
          mode: "any",
          timeout: 30,
        },
      },
    );
  });
});

describe("Fleet execution through /fleet command and fleet tool adapters", () => {
  it("spawns a member, sends initial prompt, and stops it via --all", async () => {
    const h = await createHarness();
    try {
      const spawnRes = await h.runTool({
        action: "spawn",
        name: "api",
        task: "Implement OAuth login",
      });
      assert.equal(spawnRes.isError, false);

      await h.runCommand("stop --all");
      const man = await loadManifest(h.root);
      assert.equal(man.members.api.status, "stopped");
    } finally {
      await h.cleanup();
    }
  });

  it("stops an attached member that already reached done status and transitions it to stopped", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "finisher",
        task: "FINISH_NOW",
      });
      await new Promise((r) => setTimeout(r, 150));
      const beforeStop = await loadManifest(h.root);
      assert.equal(beforeStop.members.finisher.status, "done");

      await h.runCommand("stop --all");
      const afterStop = await loadManifest(h.root);
      assert.equal(afterStop.members.finisher.status, "stopped");
    } finally {
      await h.cleanup();
    }
  });

  it("kills the live process of a detached member when stopped and clears its pid", async () => {
    const h = await createHarness();
    const sleeper = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      const m = await h.seedMember("ghost", "detached");
      const man = await loadManifest(h.root);
      man.members[m.name].pid = sleeper.pid;
      await saveManifest(man);

      await h.runCommand("stop ghost");
      const afterStop = await loadManifest(h.root);
      assert.deepEqual(
        {
          status: afterStop.members.ghost.status,
          pid: afterStop.members.ghost.pid,
          alive: isPidAlive(sleeper.pid),
        },
        {
          status: "stopped",
          pid: undefined,
          alive: false,
        },
      );
    } finally {
      try {
        sleeper.kill();
      } catch {
        // already killed
      }
      await h.cleanup();
    }
  });

  it("preserves member.task in manifest on resume while forwarding extra instructions", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("api", "stale", { task: "Implement OAuth login" });

      await h.runCommand('resume api "Also cover PKCE token refresh"');
      const manAfterResume = await loadManifest(h.root);
      const promptFile = await readFile(
        path.join(h.root, ".pi", "fleet", "prompts", "api.md"),
        "utf8",
      );
      const receivedRaw = await readFile(
        path.join(h.root, ".pi", "fleet", "wt", "api", ".rpc-received.jsonl"),
        "utf8",
      );
      await h.runCommand("stop api");

      assert.deepEqual(
        {
          taskInManifest: manAfterResume.members.api.task,
          promptFileHasExtra: promptFile.includes("Also cover PKCE token refresh"),
          rpcPromptHasExtra: receivedRaw.includes("Also cover PKCE token refresh"),
        },
        {
          taskInManifest: "Implement OAuth login",
          promptFileHasExtra: true,
          rpcPromptHasExtra: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("delivers send messages and tails member activity logs through the tool adapter", async () => {
    const h = await createHarness();
    try {
      await h.runTool({ action: "spawn", name: "worker1", task: "Initial task" });
      const sendRes = await h.runTool({
        action: "send",
        name: "worker1",
        message: "Use strict types",
      });

      const logPath = path.join(h.root, ".pi", "fleet", "logs", "worker1.jsonl");
      await writeFile(
        logPath,
        [
          JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: "DONE: completed checks" },
          }),
        ].join("\n") + "\n",
        { flag: "a" },
      );

      const logRes = await h.runTool({ action: "log", name: "worker1", n: 5 });
      await h.runTool({ action: "stop", name: "--all" });

      assert.deepEqual(
        {
          sendText: sendRes.text,
          hasToolEntry: logRes.text.includes("tool: read"),
          hasAssistantEntry: logRes.text.includes("assistant: DONE: completed checks"),
        },
        {
          sendText: "fleet: sent to 'worker1' (prompt)",
          hasToolEntry: true,
          hasAssistantEntry: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("merges only done members on merge --done and reports error level on conflicts", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("m1", "done", { unmergedCommit: true });
      await h.seedMember("m2", "running", { unmergedCommit: true });

      await h.runCommand("merge --done");
      const man = await loadManifest(h.root);
      assert.equal(man.members.m1.status, "merged");
      assert.equal(man.members.m2.status, "running");

      await h.seedMember("m3", "done", { conflictingCommit: true });
      await h.runCommand("merge --done");
      assert.equal(
        h.errors().some((e) => e.includes("merge m3 CONFLICTS in: README.md")),
        true,
      );
    } finally {
      await h.cleanup();
    }
  });

  it("cleans finished members on clean --done while leaving active and detached members intact", async () => {
    const h = await createHarness();
    try {
      const finished: MemberStatus[] = ["done", "merged", "failed", "stopped", "stale"];
      const untouched: MemberStatus[] = ["starting", "running", "idle", "detached"];

      for (const status of finished) {
        await h.seedMember(`fin-${status}`, status, {
          mergedCommit: status === "merged",
          unmergedCommit: status !== "merged",
        });
      }
      for (const status of untouched) {
        await h.seedMember(`keep-${status}`, status);
      }

      await h.runCommand("clean --done");
      const man = await loadManifest(h.root);

      assert.deepEqual(
        {
          remaining: Object.keys(man.members).sort(),
          mergedBranchGone: !(await branchExists(h.root, "fleet/fin-merged")),
          unmergedDoneBranchKept: await branchExists(h.root, "fleet/fin-done"),
          doneWorktreeGone: !existsSync(path.join(h.root, ".pi", "fleet", "wt", "fin-done")),
          errors: h.errors(),
        },
        {
          remaining: ["keep-detached", "keep-idle", "keep-running", "keep-starting"],
          mergedBranchGone: true,
          unmergedDoneBranchKept: true,
          doneWorktreeGone: true,
          errors: [],
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("deletes unmerged branches when clean --force is passed in either flag order", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("done-a", "done", { unmergedCommit: true });
      await h.runCommand("clean --done --force");

      await h.seedMember("done-b", "failed", { unmergedCommit: true });
      await h.runCommand("clean --force --done");

      assert.deepEqual(
        {
          doneABranchExists: await branchExists(h.root, "fleet/done-a"),
          doneBBranchExists: await branchExists(h.root, "fleet/done-b"),
          errors: h.errors(),
        },
        {
          doneABranchExists: false,
          doneBBranchExists: false,
          errors: [],
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("returns all members uncapped on status while capping the TUI widget at 8 rows", async () => {
    const h = await createHarness();
    try {
      for (let i = 1; i <= 10; i++) {
        await h.seedMember(`m${i}`, "done", { createdAt: i * 100 });
      }

      const statusRes = await h.runTool({ action: "status" });
      assert.deepEqual(
        {
          statusLineCount: statusRes.text.split("\n").length,
          widgetLineCount: h.widgetLines()?.length,
          widgetFooter: h.widgetLines()?.[9],
        },
        {
          statusLineCount: 11,
          widgetLineCount: 10,
          widgetFooter: " … 2 more",
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("clears the TUI widget when cleaning the last member", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("last-done", "done");
      await h.runCommand("status");
      const rendered = h.widgetLines();

      await h.runCommand("clean last-done");

      assert.deepEqual(
        { rendered, afterClean: h.widgetLines(), errors: h.errors() },
        {
          rendered: ["fleet: 1 member (0 active)", " · last-done    coder      done"],
          afterClean: undefined,
          errors: [],
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("clears a stale TUI widget on status when no members exist", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("stale", "done");
      await h.runCommand("status");
      await h.runCommand("clean stale");
      await h.runCommand("status");

      assert.deepEqual(
        { widget: h.widgetLines(), errors: h.errors() },
        { widget: undefined, errors: [] },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("clears a stale TUI widget on session_start when no members exist", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("stale", "done");
      await h.runCommand("status");
      await h.runCommand("clean stale");
      await h.reconcileSession();

      assert.deepEqual(
        { widget: h.widgetLines(), errors: h.errors() },
        { widget: undefined, errors: [] },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("persists full DONE message on member.result and clears it on resume or re-spawn", async () => {
    const h = await createHarness();
    try {
      const fullDone = "DONE: implemented auth flow\n\nDetails:\n- added token validation\n- added refresh tests";
      await h.runTool({
        action: "spawn",
        name: "finisher",
        task: `FINISH_NOW:  ${fullDone}  \n`,
      });
      await new Promise((r) => setTimeout(r, 150));
      const afterDone = await loadManifest(h.root);
      const firstPid = afterDone.members.finisher.pid;

      await h.runCommand('resume finisher "Continue with edge cases"');
      const afterResume = await loadManifest(h.root);
      await h.runCommand("stop finisher");

      assert.deepEqual(
        {
          doneStatus: afterDone.members.finisher.status,
          doneResult: afterDone.members.finisher.result,
          firstPidStoppedOnResume: !isPidAlive(firstPid),
          resumedResult: afterResume.members.finisher.result,
        },
        {
          doneStatus: "done",
          doneResult: fullDone,
          firstPidStoppedOnResume: true,
          resumedResult: undefined,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("keeps the final DONE message untruncated in log while truncating earlier assistant messages", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("logger", "done");
      const logPath = path.join(h.root, ".pi", "fleet", "logs", "logger.jsonl");
      await mkdir(path.dirname(logPath), { recursive: true });

      const longProgress = `Investigating module\n${"a".repeat(260)}`;
      const earlierDone = `DONE: first attempt\n${"b".repeat(260)}`;
      const finalDone = `DONE: final report\n\nSection 1:\n${"c".repeat(260)}\n\nSection 2: verified`;

      await writeFile(
        logPath,
        [
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: longProgress },
          }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: earlierDone },
          }),
          JSON.stringify({ type: "tool_execution_start", toolName: "bash" }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: finalDone },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const logRes = await h.runTool({ action: "log", name: "logger", n: 10 });

      assert.deepEqual(
        {
          progressTruncated: !logRes.text.includes("a".repeat(240)) && logRes.text.includes("assistant: Investigating module "),
          earlierDoneTruncated: !logRes.text.includes("b".repeat(240)) && logRes.text.includes("assistant: DONE: first attempt "),
          finalDoneUntruncated: logRes.text.includes(`assistant: ${finalDone}`),
        },
        {
          progressTruncated: true,
          earlierDoneTruncated: true,
          finalDoneUntruncated: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("resolves wait immediately for already-settled or needsAttention members and rejects unknown members", async () => {
    const h = await createHarness();
    try {
      const missingRes = await h.runTool({ action: "wait", name: "missing" });

      const fullResult = "DONE: completed auth\n\nParagraph 2: all 14 tests green";
      await h.seedMember("m-done", "done", { unmergedCommit: true, result: fullResult });
      await h.seedMember("m-ask", "running", { needsAttention: "Use JWT or session cookies?" });
      await h.seedMember("m-failed", "failed");
      await h.seedMember("m-stopped", "stopped");
      await h.seedMember("m-stale", "stale");
      await h.seedMember("m-merged", "merged", { mergedCommit: true });

      const doneWait = await h.runTool({ action: "wait", name: "m-done" });
      const askWait = await h.runTool({ action: "wait", name: "m-ask" });
      const allWait = await h.runTool({ action: "wait" });

      assert.deepEqual(
        {
          missingError: missingRes.isError && missingRes.text.includes("no such member 'missing'"),
          doneHasStatus: doneWait.text.includes("status=done"),
          doneHasCommit: doneWait.text.includes("work by m-done"),
          doneHasFullResult: doneWait.text.includes(fullResult),
          askHasQuestion: askWait.text.includes("Use JWT or session cookies?"),
          allHasAllSettled:
            !allWait.isError &&
            allWait.text.includes("m-done") &&
            allWait.text.includes("m-ask") &&
            allWait.text.includes("m-failed") &&
            allWait.text.includes("m-stopped") &&
            allWait.text.includes("m-stale") &&
            allWait.text.includes("m-merged"),
        },
        {
          missingError: true,
          doneHasStatus: true,
          doneHasCommit: true,
          doneHasFullResult: true,
          askHasQuestion: true,
          allHasAllSettled: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("blocks wait on running members until they finish with DONE, write FLEET_ASK.md, or exit unexpectedly", async () => {
    const h = await createHarness();
    try {
      const asyncReport = "DONE: completed async work\n\nAll checks passed";
      await h.runTool({
        action: "spawn",
        name: "m-done",
        task: `DELAY_DONE:120:${asyncReport}`,
      });
      const doneWait = await h.runTool({ action: "wait", name: "m-done" });

      await h.runTool({
        action: "spawn",
        name: "m-ask",
        task: "WRITE_ASK:80:Should we support legacy tokens?",
      });
      const askWait = await h.runTool({ action: "wait", name: "m-ask" });

      await h.runTool({
        action: "spawn",
        name: "m-crash",
        task: "EXIT_AFTER:80:1",
      });
      const crashWait = await h.runTool({ action: "wait", name: "m-crash" });

      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          doneResolved: doneWait.text.includes("status=done") && doneWait.text.includes(asyncReport),
          askResolved: askWait.text.includes("ASK: Should we support legacy tokens?"),
          crashResolved: crashWait.text.includes("status=failed"),
        },
        {
          doneResolved: true,
          askResolved: true,
          crashResolved: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("supports wait mode=any, wait --all, and reports settled vs running members on timeout", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "fast",
        task: "DELAY_DONE:100:DONE: fast member finished",
      });
      await h.runTool({
        action: "spawn",
        name: "slow",
        task: "Stay running until prompted",
      });

      const anyRes = await h.runTool({
        action: "wait",
        names: ["fast", "slow"],
        mode: "any",
      });
      const manAfterAny = await loadManifest(h.root);

      const timeoutRes = await h.runTool({
        action: "wait",
        timeout: 0.15,
      });

      await h.runTool({
        action: "send",
        name: "slow",
        message: "FINISH_NOW:DONE: slow member finished",
      });
      const allRes = await h.runTool({ action: "wait", name: "--all" });

      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          fastDoneAfterAny: manAfterAny.members.fast.status,
          slowStillRunningAfterAny: manAfterAny.members.slow.status,
          anyHasFastResult: anyRes.text.includes("DONE: fast member finished"),
          timeoutIndicatesTimeout: /timed out/i.test(timeoutRes.text),
          timeoutShowsSettled: timeoutRes.text.includes("settled: fast"),
          timeoutShowsRunning: timeoutRes.text.includes("running: slow"),
          allHasBothResults:
            allRes.text.includes("DONE: fast member finished") &&
            allRes.text.includes("DONE: slow member finished"),
        },
        {
          fastDoneAfterAny: "done",
          slowStillRunningAfterAny: "running",
          anyHasFastResult: true,
          timeoutIndicatesTimeout: true,
          timeoutShowsSettled: true,
          timeoutShowsRunning: true,
          allHasBothResults: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("writes review-context.md with target, diff base, assignment, commits, and diff for reviewer with --over branch, and not for coder", async () => {
    const h = await createHarness();
    try {
      const apiMember = await h.seedMember("api", "done", { unmergedCommit: true });
      await h.runTool({
        action: "spawn",
        name: "impl",
        role: "coder",
        over: "fleet/api",
        task: "Follow-up coder work",
      });
      await h.runTool({
        action: "spawn",
        name: "rev-branch",
        role: "reviewer",
        over: "fleet/api",
        task: "Check api changes for regressions",
      });
      await h.runCommand("stop --all");

      const coderCtxPath = path.join(h.root, ".pi", "fleet", "wt", "impl", ".pi", "fleet", "review-context.md");
      const revCtxPath = path.join(h.root, ".pi", "fleet", "wt", "rev-branch", ".pi", "fleet", "review-context.md");
      const content = await readFile(revCtxPath, "utf8");

      await h.runCommand('resume rev-branch "Re-check after feedback"');
      await h.runCommand("stop --all");
      const contentAfterResume = await readFile(revCtxPath, "utf8");

      assert.deepEqual(
        {
          coderHasReviewContext: existsSync(coderCtxPath),
          hasTarget: content.includes("Target: `fleet/api`"),
          hasDiffBase: content.includes(`Diff base: \`${apiMember.baseRef}\``),
          hasAssignment: content.includes("## Assignment\n\nCheck api changes for regressions"),
          hasCommit: content.includes("work by api"),
          hasDiff: content.includes("api.txt"),
          preservedOnResume: contentAfterResume.includes("Target: `fleet/api`") && contentAfterResume.includes("api.txt"),
        },
        {
          coderHasReviewContext: false,
          hasTarget: true,
          hasDiffBase: true,
          hasAssignment: true,
          hasCommit: true,
          hasDiff: true,
          preservedOnResume: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("writes review-context.md when spawning a reviewer without --over", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "rev-default",
        role: "reviewer",
        task: "Audit current HEAD state",
      });
      await h.runCommand("stop --all");

      const man = await loadManifest(h.root);
      const revCtxPath = path.join(h.root, ".pi", "fleet", "wt", "rev-default", ".pi", "fleet", "review-context.md");
      const exists = existsSync(revCtxPath);
      const content = exists ? await readFile(revCtxPath, "utf8") : "";

      assert.deepEqual(
        {
          exists,
          hasTarget: content.includes(`Target: \`${man.members["rev-default"].baseRef}\``),
          hasDiffBase: content.includes("Diff base: `HEAD`"),
          hasAssignment: content.includes("## Assignment\n\nAudit current HEAD state"),
          hasNoCommits: content.includes("## Commits\n\n(no commits)"),
        },
        {
          exists: true,
          hasTarget: true,
          hasDiffBase: true,
          hasAssignment: true,
          hasNoCommits: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("supports two-dot and three-dot commit ranges in --over for reviewer members", async () => {
    const h = await createHarness();
    try {
      await git(h.root, "checkout", "-b", "feature");
      await writeFile(path.join(h.root, "v1.txt"), "v1\n", "utf8");
      await git(h.root, "add", "v1.txt");
      await git(h.root, "commit", "-m", "add v1");
      const v1Rev = await headRev(h.root, "HEAD");

      await writeFile(path.join(h.root, "v2.txt"), "v2\n", "utf8");
      await git(h.root, "add", "v2.txt");
      await git(h.root, "commit", "-m", "add v2");
      const featureHead = await headRev(h.root, "HEAD");

      await git(h.root, "checkout", "main");
      await writeFile(path.join(h.root, "main-only.txt"), "main\n", "utf8");
      await git(h.root, "add", "main-only.txt");
      await git(h.root, "commit", "-m", "advance main");

      const twoDotRes = await h.runTool({
        action: "spawn",
        name: "rev-two-dot",
        role: "reviewer",
        over: `${v1Rev}..feature`,
        task: "Review v2 commit range",
      });
      const threeDotRes = await h.runTool({
        action: "spawn",
        name: "rev-three-dot",
        role: "reviewer",
        over: "main...feature",
        task: "Review feature branch against main merge-base",
      });
      const badBaseRes = await h.runTool({
        action: "spawn",
        name: "rev-bad-base",
        role: "reviewer",
        over: "nonexistent-ref..feature",
        task: "Should reject unknown base ref",
      });
      await h.runCommand("stop --all");

      const twoDotWt = path.join(h.root, ".pi", "fleet", "wt", "rev-two-dot");
      const threeDotWt = path.join(h.root, ".pi", "fleet", "wt", "rev-three-dot");
      const twoDotCtx = await readFile(path.join(twoDotWt, ".pi", "fleet", "review-context.md"), "utf8");
      const threeDotCtx = await readFile(path.join(threeDotWt, ".pi", "fleet", "review-context.md"), "utf8");

      assert.deepEqual(
        {
          twoDotError: twoDotRes.isError,
          threeDotError: threeDotRes.isError,
          badBaseError: badBaseRes.isError,
          twoDotHead: await headRev(twoDotWt, "HEAD"),
          threeDotHead: await headRev(threeDotWt, "HEAD"),
          twoDotDiffBase: twoDotCtx.includes(`Diff base: \`${v1Rev}\``),
          twoDotHasV2Commit: twoDotCtx.includes("add v2"),
          twoDotHasV1Commit: twoDotCtx.includes("add v1"),
          twoDotHasV2Diff: twoDotCtx.includes("v2.txt"),
          twoDotHasV1Diff: twoDotCtx.includes("v1.txt"),
          threeDotDiffBase: threeDotCtx.includes("Diff base: `main`"),
          threeDotHasV1Commit: threeDotCtx.includes("add v1"),
          threeDotHasV2Commit: threeDotCtx.includes("add v2"),
          threeDotHasMainOnlyCommit: threeDotCtx.includes("advance main"),
          threeDotHasV1Diff: threeDotCtx.includes("v1.txt"),
          threeDotHasV2Diff: threeDotCtx.includes("v2.txt"),
          threeDotHasMainOnlyDiff: threeDotCtx.includes("main-only.txt"),
        },
        {
          twoDotError: false,
          threeDotError: false,
          badBaseError: true,
          twoDotHead: featureHead,
          threeDotHead: featureHead,
          twoDotDiffBase: true,
          twoDotHasV2Commit: true,
          twoDotHasV1Commit: false,
          twoDotHasV2Diff: true,
          twoDotHasV1Diff: false,
          threeDotDiffBase: true,
          threeDotHasV1Commit: true,
          threeDotHasV2Commit: true,
          threeDotHasMainOnlyCommit: false,
          threeDotHasV1Diff: true,
          threeDotHasV2Diff: true,
          threeDotHasMainOnlyDiff: false,
        },
      );
    } finally {
      await h.cleanup();
    }
  });
});
