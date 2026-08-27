import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFile, appendFile, readFile, listFiles } from "../src/tools/filesystem.ts";
import type { ToolContext } from "../src/tools/index.ts";
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
