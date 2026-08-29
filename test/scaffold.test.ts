import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeCreateProject } from "../src/tools/scaffold.ts";
import type { ToolContext } from "../src/tools/index.ts";
import { nullBus, tmpDir } from "./helpers.ts";

async function ctx(): Promise<{ dir: string; ctx: ToolContext }> {
  const dir = await tmpDir("scaffold");
  return {
    dir,
    ctx: { agent: "carol", bus: nullBus, broker: {} as ToolContext["broker"], workspace: dir, writeRoots: [] },
  };
}

test("create_project scaffolds a canvas game with the wiring already in place", async () => {
  const { dir, ctx: c } = await ctx();
  const out = await makeCreateProject().run({ name: "Snake Game!", kind: "canvas-game" }, c);
  assert.match(out, /projects\/snake-game\/ \(canvas-game\); entry: projects\/snake-game\/index\.html/);

  const html = await fs.readFile(path.join(dir, "projects/snake-game/index.html"), "utf8");
  assert.match(html, /<canvas id="game"/);
  assert.match(html, /addEventListener\("keydown"/);
  assert.match(html, /requestAnimationFrame\(loop\)/);
});

test("create_project makes a node-lib with a runnable test script", async () => {
  const { dir, ctx: c } = await ctx();
  await makeCreateProject().run({ name: "my utils", kind: "node-lib" }, c);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, "projects/my-utils/package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.name, "my-utils");
  assert.ok(await fs.readFile(path.join(dir, "projects/my-utils/test.js"), "utf8"));
});

test("create_project never overwrites an existing file", async () => {
  const { dir, ctx: c } = await ctx();
  await fs.mkdir(path.join(dir, "projects/keep"), { recursive: true });
  await fs.writeFile(path.join(dir, "projects/keep/index.html"), "MINE");
  const out = await makeCreateProject().run({ name: "keep", kind: "webapp" }, c);
  assert.match(out, /kept existing: index\.html/);
  assert.equal(await fs.readFile(path.join(dir, "projects/keep/index.html"), "utf8"), "MINE");
});

test("create_project defaults an unknown kind to webapp", async () => {
  const { dir, ctx: c } = await ctx();
  const out = await makeCreateProject().run({ name: "thing", kind: "nonsense" }, c);
  assert.match(out, /\(webapp\)/);
  assert.ok(await fs.readFile(path.join(dir, "projects/thing/index.html"), "utf8"));
});

test("create_project rejects a blank name", async () => {
  const { ctx: c } = await ctx();
  assert.match(await makeCreateProject().run({ name: "   " }, c), /a name is required/);
});
