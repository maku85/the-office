import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  writeFile,
  appendFile,
  readFile,
  listFiles,
  editFile,
  makeRunTests,
} from "../src/tools/filesystem.ts";
import type { ToolContext } from "../src/tools/index.ts";
import { config } from "../src/config.ts";
import { nullBus, tmpDir } from "./helpers.ts";

async function ctxWith(writeRoots: string[]): Promise<{ dir: string; ctx: ToolContext }> {
  const dir = await tmpDir("fs");
  const ctx = {
    agent: "bob",
    bus: nullBus,
    broker: {} as ToolContext["broker"],
    workspace: dir,
    writeRoots,
  };
  return { dir, ctx };
}

test("write inside a permitted root succeeds", async () => {
  const { dir, ctx } = await ctxWith(["projects/", "shared/"]);
  const out = await writeFile.run({ path: "projects/demo/a.md", content: "hi" }, ctx);
  assert.match(out, /wrote 2 bytes/);
  assert.equal(await fs.readFile(path.join(dir, "projects/demo/a.md"), "utf8"), "hi");
});

test("write outside the permitted roots is refused", async () => {
  const { ctx } = await ctxWith(["projects/"]);
  await assert.rejects(
    () => writeFile.run({ path: "notes.md", content: "x" }, ctx),
    /may only write under/,
  );
});

test("path traversal out of the workspace is refused", async () => {
  const { ctx } = await ctxWith(["projects/"]);
  await assert.rejects(
    () => writeFile.run({ path: "../escape.md", content: "x" }, ctx),
    /may only write under|escapes the workspace/,
  );
});

test("empty writeRoots means the agent is read-only", async () => {
  const { ctx } = await ctxWith([]);
  await assert.rejects(
    () => writeFile.run({ path: "projects/a.md", content: "x" }, ctx),
    /has no write access/,
  );
});

test("append_file keeps existing content and adds a separator", async () => {
  const { dir, ctx } = await ctxWith(["projects/"]);
  await writeFile.run({ path: "projects/log.md", content: "line1" }, ctx);
  await appendFile.run({ path: "projects/log.md", content: "line2" }, ctx);
  assert.equal(
    await fs.readFile(path.join(dir, "projects/log.md"), "utf8"),
    "line1\nline2",
  );
});

test("read_file and list_files are not gated by writeRoots", async () => {
  const { dir, ctx } = await ctxWith([]);
  await fs.writeFile(path.join(dir, "outside.txt"), "readable");
  assert.equal(await readFile.run({ path: "outside.txt" }, ctx), "readable");
  assert.match(await listFiles.run({ dir: "." }, ctx), /outside\.txt/);
});

test("reads still cannot escape the workspace", async () => {
  const { ctx } = await ctxWith([]);
  await assert.rejects(() => readFile.run({ path: "../../etc/hosts" }, ctx), /escapes the workspace/);
});

test("a symlinked directory cannot be used to read outside the workspace", async () => {
  const { dir, ctx } = await ctxWith([]);
  const outside = await tmpDir("fs-outside");
  await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
  await fs.symlink(outside, path.join(dir, "escape"));
  await assert.rejects(
    () => readFile.run({ path: "escape/secret.txt" }, ctx),
    /escapes the workspace via symlink/,
  );
});

test("edit_file replaces the exact substring", async () => {
  const { dir, ctx } = await ctxWith(["projects/"]);
  await writeFile.run({ path: "projects/app.js", content: "const port = 3000;\n" }, ctx);
  const out = await editFile.run(
    { path: "projects/app.js", find: "3000", replace: "process.env.PORT || 3000" },
    ctx,
  );
  assert.match(out, /1 replacement/);
  assert.equal(
    await fs.readFile(path.join(dir, "projects/app.js"), "utf8"),
    "const port = process.env.PORT || 3000;\n",
  );
});

test("edit_file fails without writing when `find` is absent", async () => {
  const { dir, ctx } = await ctxWith(["projects/"]);
  await writeFile.run({ path: "projects/a.txt", content: "hello world" }, ctx);
  await assert.rejects(
    () => editFile.run({ path: "projects/a.txt", find: "goodbye", replace: "x" }, ctx),
    /not present/,
  );
  assert.equal(await fs.readFile(path.join(dir, "projects/a.txt"), "utf8"), "hello world");
});

test("edit_file fails on an unexpected occurrence count", async () => {
  const { dir, ctx } = await ctxWith(["projects/"]);
  await writeFile.run({ path: "projects/a.txt", content: "a a a" }, ctx);
  await assert.rejects(
    () => editFile.run({ path: "projects/a.txt", find: "a", replace: "b" }, ctx),
    /occurs 3× .* expected 1/,
  );
  await assert.doesNotReject(() =>
    editFile.run({ path: "projects/a.txt", find: "a", replace: "b", expected_count: 3 }, ctx),
  );
  assert.equal(await fs.readFile(path.join(dir, "projects/a.txt"), "utf8"), "b b b");
});

test("edit_file respects writeRoots and needs an existing file", async () => {
  const { ctx } = await ctxWith(["projects/"]);
  await assert.rejects(
    () => editFile.run({ path: "outside.txt", find: "a", replace: "b" }, ctx),
    /may only write under/,
  );
  await assert.rejects(
    () => editFile.run({ path: "projects/missing.txt", find: "a", replace: "b" }, ctx),
    /does not exist/,
  );
});

test("run_tests reports a passing command's output", async () => {
  const prev = config.testCmd;
  config.testCmd = "echo TESTS-GREEN";
  try {
    const { ctx } = await ctxWith([]);
    const out = await makeRunTests().run({}, ctx);
    assert.match(out, /tests passed/);
    assert.match(out, /TESTS-GREEN/);
  } finally {
    config.testCmd = prev;
  }
});

test("run_tests hands back the failure output instead of throwing", async () => {
  const prev = config.testCmd;
  config.testCmd = "echo BOOM >&2; exit 2";
  try {
    const { ctx } = await ctxWith([]);
    const out = await makeRunTests().run({}, ctx);
    assert.match(out, /tests FAILED \(exit 2\)/);
    assert.match(out, /BOOM/);
  } finally {
    config.testCmd = prev;
  }
});

test("run_tests confines its `dir` to the workspace", async () => {
  const { ctx } = await ctxWith([]);
  await assert.rejects(
    () => makeRunTests().run({ dir: "../.." }, ctx),
    /escapes the workspace/,
  );
});
