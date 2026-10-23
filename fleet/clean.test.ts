import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { parseFleetCommand } from "./fleet.ts";
import { addWorktree, branchExists, git, headRev, mergeBranch } from "./gitw.ts";
import registerFleet from "./index.ts";
import { loadManifest, saveManifest } from "./manifest.ts";
import type { Member, MemberStatus } from "./types.ts";

interface TestHarness {
  root: string;
  errors: () => string[];
  runFleetCommand: (args: string) => Promise<void>;
  seedMember: (name: string, status: MemberStatus, opts?: { unmergedCommit?: boolean; mergedCommit?: boolean }) => Promise<Member>;
  cleanup: () => Promise<void>;
}

async function createTestHarness(): Promise<TestHarness> {
  const rawRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-clean-"));
  await git(rawRoot, "init", "-b", "main");
  await git(rawRoot, "config", "user.email", "test@example.com");
  await git(rawRoot, "config", "user.name", "Test User");
  await writeFile(path.join(rawRoot, "README.md"), "init\n", "utf8");
  await git(rawRoot, "add", "README.md");
  await git(rawRoot, "commit", "-m", "initial");

  const root = await git(rawRoot, "rev-parse", "--show-toplevel");
  const baseRef = await headRev(root);
  const notifications: Array<{ text: string; level: string }> = [];

  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const fakePi: any = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) => {
      if (name === "fleet") commandHandler = spec.handler;
    },
  };
  registerFleet(fakePi);

  const ctx = {
    cwd: root,
    ui: {
      notify: (text: string, level = "info") => {
        notifications.push({ text, level });
      },
      setWidget: () => {},
    },
  };

  async function seedMember(
    name: string,
    status: MemberStatus,
    opts?: { unmergedCommit?: boolean; mergedCommit?: boolean },
  ): Promise<Member> {
    const branch = `fleet/${name}`;
    const wt = path.join(root, ".pi", "fleet", "wt", name);
    await addWorktree(root, wt, branch, baseRef);
    if (opts?.unmergedCommit || opts?.mergedCommit) {
      await writeFile(path.join(wt, `${name}.txt`), `${name}\n`, "utf8");
      await git(wt, "add", `${name}.txt`);
      await git(wt, "commit", "-m", `work by ${name}`);
    }
    if (opts?.mergedCommit) {
      await mergeBranch(root, branch, `merge ${name}`);
    }
    const man = await loadManifest(root);
    const now = Date.now();
    const member: Member = {
      name,
      role: "coder",
      task: `task for ${name}`,
      branch,
      worktree: wt,
      baseRef,
      status,
      createdAt: now,
      updatedAt: now,
    };
    man.members[name] = member;
    await saveManifest(man);
    registerFleet(fakePi);
    return member;
  }

  return {
    root,
    errors: () => notifications.filter((n) => n.level === "error").map((n) => n.text),
    runFleetCommand: async (args: string) => {
      assert.ok(commandHandler, "fleet command handler must be registered");
      await commandHandler(args, ctx);
    },
    seedMember,
    cleanup: async () => {
      await rm(rawRoot, { recursive: true, force: true });
    },
  };
}

test("parseFleetCommand preserves --done and --all targets and reads --force in either order", () => {
  assert.deepEqual(
    [
      parseFleetCommand("clean --done"),
      parseFleetCommand("clean --all"),
      parseFleetCommand("clean --done --force"),
      parseFleetCommand("clean --force --all"),
      parseFleetCommand("clean alpha --force"),
    ],
    [
      { action: "clean", target: "--done" },
      { action: "clean", target: "--all" },
      { action: "clean", target: "--done", force: true },
      { action: "clean", target: "--all", force: true },
      { action: "clean", target: "alpha", force: true },
    ],
  );
});

test("/fleet clean --done cleans finished members (done, merged, failed, stopped, stale) and leaves active/detached members untouched", async () => {
  const h = await createTestHarness();
  try {
    const finishedStatuses: MemberStatus[] = ["done", "merged", "failed", "stopped", "stale"];
    const untouchedStatuses: MemberStatus[] = ["starting", "running", "idle", "detached"];

    for (const status of finishedStatuses) {
      await h.seedMember(`fin-${status}`, status, {
        mergedCommit: status === "merged",
        unmergedCommit: status !== "merged",
      });
    }
    for (const status of untouchedStatuses) {
      await h.seedMember(`keep-${status}`, status);
    }

    await h.runFleetCommand("clean --done");

    const man = await loadManifest(h.root);
    assert.deepEqual(
      {
        remainingNames: Object.keys(man.members).sort(),
        mergedBranchGone: !(await branchExists(h.root, "fleet/fin-merged")),
        unmergedDoneBranchKept: await branchExists(h.root, "fleet/fin-done"),
        doneWorktreeGone: !existsSync(path.join(h.root, ".pi", "fleet", "wt", "fin-done")),
        errors: h.errors(),
      },
      {
        remainingNames: ["keep-detached", "keep-idle", "keep-running", "keep-starting"],
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

test("/fleet clean --all cleans every registered member", async () => {
  const h = await createTestHarness();
  try {
    await h.seedMember("alpha", "running", { unmergedCommit: true });
    await h.seedMember("beta", "done", { mergedCommit: true });

    await h.runFleetCommand("clean --all");

    const man = await loadManifest(h.root);
    assert.deepEqual(
      {
        remainingNames: Object.keys(man.members),
        alphaBranchKept: await branchExists(h.root, "fleet/alpha"),
        betaBranchGone: !(await branchExists(h.root, "fleet/beta")),
        errors: h.errors(),
      },
      {
        remainingNames: [],
        alphaBranchKept: true,
        betaBranchGone: true,
        errors: [],
      },
    );
  } finally {
    await h.cleanup();
  }
});

test("/fleet clean <name> keeps an unmerged branch unless --force is set", async () => {
  const h = await createTestHarness();
  try {
    await h.seedMember("named-keep", "stopped", { unmergedCommit: true });
    await h.seedMember("named-force", "stopped", { unmergedCommit: true });

    await h.runFleetCommand("clean named-keep");
    await h.runFleetCommand("clean named-force --force");

    const man = await loadManifest(h.root);
    assert.deepEqual(
      {
        remainingNames: Object.keys(man.members),
        namedKeepBranchExists: await branchExists(h.root, "fleet/named-keep"),
        namedForceBranchExists: await branchExists(h.root, "fleet/named-force"),
        errors: h.errors(),
      },
      {
        remainingNames: [],
        namedKeepBranchExists: true,
        namedForceBranchExists: false,
        errors: [],
      },
    );
  } finally {
    await h.cleanup();
  }
});

test("/fleet clean --done and /fleet clean --all pass --force in either flag order", async () => {
  const h = await createTestHarness();
  try {
    await h.seedMember("done-a", "done", { unmergedCommit: true });
    await h.runFleetCommand("clean --done --force");

    await h.seedMember("done-b", "failed", { unmergedCommit: true });
    await h.runFleetCommand("clean --force --done");

    await h.seedMember("all-a", "running", { unmergedCommit: true });
    await h.runFleetCommand("clean --all --force");

    await h.seedMember("all-b", "idle", { unmergedCommit: true });
    await h.runFleetCommand("clean --force --all");

    const man = await loadManifest(h.root);
    assert.deepEqual(
      {
        remainingNames: Object.keys(man.members),
        doneABranchExists: await branchExists(h.root, "fleet/done-a"),
        doneBBranchExists: await branchExists(h.root, "fleet/done-b"),
        allABranchExists: await branchExists(h.root, "fleet/all-a"),
        allBBranchExists: await branchExists(h.root, "fleet/all-b"),
        errors: h.errors(),
      },
      {
        remainingNames: [],
        doneABranchExists: false,
        doneBBranchExists: false,
        allABranchExists: false,
        allBBranchExists: false,
        errors: [],
      },
    );
  } finally {
    await h.cleanup();
  }
});

test("/fleet clean --done and /fleet clean --all succeed when no members match", async () => {
  const h = await createTestHarness();
  try {
    await h.runFleetCommand("clean --all");
    await h.runFleetCommand("clean --done");

    await h.seedMember("active-one", "running");
    await h.runFleetCommand("clean --done");

    const man = await loadManifest(h.root);
    assert.deepEqual(
      {
        remainingNames: Object.keys(man.members),
        errors: h.errors(),
      },
      {
        remainingNames: ["active-one"],
        errors: [],
      },
    );
  } finally {
    await h.cleanup();
  }
});

test("/fleet clean and /fleet clean --force report usage error", async () => {
  const h = await createTestHarness();
  try {
    await h.runFleetCommand("clean");
    await h.runFleetCommand("clean --force");

    assert.deepEqual(h.errors(), [
      "fleet: usage: /fleet clean <name|--done|--all> [--force]",
      "fleet: usage: /fleet clean <name|--done|--all> [--force]",
    ]);
  } finally {
    await h.cleanup();
  }
});
