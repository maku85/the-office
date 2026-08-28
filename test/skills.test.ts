import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { loadSkills } from "../src/skills/index.ts";
import { makeUseSkill } from "../src/tools/skill.ts";
import type { ToolContext } from "../src/tools/index.ts";
import { recordingBus, tmpDir } from "./helpers.ts";

async function skillsDir(): Promise<string> {
  const dir = await tmpDir("skills");
  const write = (name: string, body: string) =>
    fs.mkdir(path.join(dir, name), { recursive: true }).then(() =>
      fs.writeFile(path.join(dir, name, "SKILL.md"), body),
    );
  await write(
    "canvas-game",
    `---\nname: canvas-game\ndescription: build a canvas game\nroles: [developer, designer]\nkeywords: [game, canvas]\n---\nUse a fixed timestep. clearRect every frame.`,
  );
  await write(
    "write-spec",
    `---\nname: write-spec\ndescription: write a good SPEC\nroles: [analyst]\n---\nNumber the acceptance criteria.`,
  );
  await write("empty", `---\nname: empty\n---\n`); // no body → skipped
  return dir;
}

test("loadSkills parses front-matter and body", async () => {
  const reg = await loadSkills(await skillsDir());
  assert.deepEqual(reg.all.map((s) => s.name).sort(), ["canvas-game", "write-spec"]);
  const cg = reg.get("canvas-game")!;
  assert.equal(cg.description, "build a canvas game");
  assert.deepEqual(cg.roles, ["developer", "designer"]);
  assert.match(cg.body, /fixed timestep/);
});

test("index is compact and filters by role", async () => {
  const reg = await loadSkills(await skillsDir());
  assert.equal(reg.index().split("\n").length, 2);
  assert.match(reg.index(["developer"]), /canvas-game/);
  assert.doesNotMatch(reg.index(["developer"]), /write-spec/);
  assert.match(reg.index(["analyst"]), /write-spec/);
});

test("resolve concatenates known skills and skips unknown", async () => {
  const reg = await loadSkills(await skillsDir());
  const out = reg.resolve(["canvas-game", "does-not-exist"]);
  assert.match(out, /# Skill: canvas-game/);
  assert.match(out, /fixed timestep/);
  assert.doesNotMatch(out, /does-not-exist/);
  assert.equal(reg.resolve([]), "");
  assert.equal(reg.resolve(undefined), "");
});

test("a missing skills dir yields an empty registry", async () => {
  const reg = await loadSkills("/no/such/skills");
  assert.deepEqual(reg.all, []);
  assert.equal(reg.index(), "");
  assert.equal(reg.resolve(["x"]), "");
});

test("multiple dirs merge; a later dir overrides on a name clash; missing dirs skip", async () => {
  const a = await skillsDir(); // has canvas-game, write-spec
  const b = await tmpDir("skills-ext");
  await fs.mkdir(path.join(b, "canvas-game"));
  await fs.writeFile(
    path.join(b, "canvas-game", "SKILL.md"),
    `---\nname: canvas-game\ndescription: OVERRIDDEN\n---\nnew body`,
  );
  await fs.mkdir(path.join(b, "extra"));
  await fs.writeFile(path.join(b, "extra", "SKILL.md"), `---\nname: extra\n---\nextra body`);

  const reg = await loadSkills([a, "/no/such/dir", b]);
  assert.deepEqual(reg.all.map((s) => s.name).sort(), ["canvas-game", "extra", "write-spec"]);
  assert.equal(reg.get("canvas-game")!.description, "OVERRIDDEN");
  assert.match(reg.get("canvas-game")!.body, /new body/);
});

test("use_skill returns the body, or an error for an unknown name, and emits skill_use", async () => {
  const reg = await loadSkills(await skillsDir());
  const tool = makeUseSkill(reg);
  const { bus, events } = recordingBus();
  const ctx = { agent: "bob", bus } as unknown as ToolContext;

  assert.match(await tool.run({ name: "write-spec" }, ctx), /Number the acceptance/);
  assert.match(await tool.run({ name: "ghost" }, ctx), /no skill named "ghost"/);

  const uses = events.filter((e) => e.type === "skill_use") as Array<{ skill: string; found: boolean }>;
  assert.deepEqual(
    uses.map((u) => [u.skill, u.found]),
    [["write-spec", true], ["ghost", false]],
  );
});
