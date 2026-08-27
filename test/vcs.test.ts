import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Vcs, slugify } from "../src/orchestrator/vcs.ts";
import { nullBus, tmpDir, exists } from "./helpers.ts";

const px = promisify(execFile);

test("slugify produces safe, bounded branch fragments", () => {
  assert.equal(slugify("Build the Overview Doc!"), "build-the-overview-doc");
  assert.equal(slugify("   ??? "), "goal");
  assert.ok(slugify("x".repeat(100)).length <= 40);
});

test("goal lifecycle: isolated worktree -> per-task commits -> merge -> undo", async () => {
  const root = await tmpDir("vcs");
  await fs.mkdir(path.join(root, "projects"), { recursive: true });
  const vcs = await Vcs.create(root, nullBus, "auto");
  assert.equal(vcs.enabled, true);

  const goalId = "abcdef12-0000-4000-8000-000000000000";
  const tree = await vcs.startGoal(goalId, slugify("add feature"));
  assert.notEqual(tree, root, "goal should get its own worktree dir");

  await fs.mkdir(path.join(tree, "projects"), { recursive: true });
  await fs.writeFile(path.join(tree, "projects/feature.md"), "content\n");
  await vcs.commitTask(goalId, "bob", "create feature");

  const { merged, commit } = await vcs.finishGoal(goalId, "add feature");
  assert.equal(merged, true);
  assert.ok(commit);

  assert.equal(await exists(path.join(root, "projects/feature.md")), true, "file reaches main");
  const worktrees = (await px("git", ["-C", root, "worktree", "list"])).stdout.trim().split("\n");
  assert.equal(worktrees.length, 1, "goal worktree removed after merge");

  assert.equal(await vcs.revert(commit as string), true);
  assert.equal(
    await exists(path.join(root, "projects/feature.md")),
    false,
    "undo removes the merged file",
  );
});

test("an abandoned goal never reaches main", async () => {
  const root = await tmpDir("vcs");
  const vcs = await Vcs.create(root, nullBus, "auto");
  const goalId = "beef0000-0000-4000-8000-000000000000";
  const tree = await vcs.startGoal(goalId, slugify("scratch"));
  await fs.writeFile(path.join(tree, "junk.txt"), "junk\n");
  await vcs.commitTask(goalId, "bob", "make a mess");
  await vcs.abandonGoal(goalId, false);
  assert.equal(await exists(path.join(root, "junk.txt")), false);
});

test("regression: a workspace nested inside another repo never touches the parent", async () => {
  const parent = await tmpDir("parent");
  await px("git", ["-C", parent, "init", "-q"]);
  await fs.writeFile(path.join(parent, "code.txt"), "parent file");
  const ws = path.join(parent, "workspace");
  await fs.mkdir(ws);

  const vcs = await Vcs.create(ws, nullBus, "auto");
  assert.equal(vcs.enabled, true);

  const parentLog = await px("git", ["-C", parent, "log", "--oneline"]).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  assert.equal(parentLog, "", "parent repo still has no commits");
  assert.equal(await exists(path.join(ws, ".git")), true, "workspace got its own repo");
});

test("mode 'off' disables version control entirely", async () => {
  const root = await tmpDir("vcs-off");
  const vcs = await Vcs.create(root, nullBus, "off");
  assert.equal(vcs.enabled, false);
  assert.equal(await vcs.startGoal("x", "y"), root, "startGoal returns the plain workspace");
  assert.equal(await exists(path.join(root, ".git")), false);
});
