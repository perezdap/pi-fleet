import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseFleetCommand, toolParamsToCommand } from "./fleet.ts";
import { addWorktree, branchExists, git, headRev, mergeBranch } from "./gitw.ts";
import registerFleet from "./index.ts";
import { loadManifest, saveManifest } from "./manifest.ts";
import type { Member, MemberStatus, NotifyLevel } from "./types.ts";

const FAKE_PI_SCRIPT = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
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
    }
  }
});
`;

interface TestHarness {
  root: string;
  notifications: Array<{ text: string; level: NotifyLevel }>;
  widgetLines: () => string[];
  errors: () => string[];
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
  let currentWidget: string[] = [];
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let toolExecutor:
    | ((id: string, params: any, sig: any, upd: any, ctx: any) => Promise<any>)
    | undefined;
  const shutdownHandlers: Array<() => Promise<void> | void> = [];

  function bindExtension(): void {
    shutdownHandlers.length = 0;
    const fakePi: any = {
      on: (event: string, fn: () => Promise<void> | void) => {
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
      setWidget: (_id: string, lines: string[]) => {
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
          widgetLineCount: h.widgetLines().length,
          widgetFooter: h.widgetLines()[9],
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
});
