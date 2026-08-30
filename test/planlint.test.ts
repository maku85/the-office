import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan } from "../src/orchestrator/planlint.ts";

test("a clean plan produces no warnings", () => {
  const w = validatePlan(
    [
      { title: "write SPEC", assignee: "analyst" },
      {
        title: "build the app",
        assignee: "developer",
        reviewedBy: "qa",
        dependsOn: ["write SPEC"],
      },
    ],
    "build a small web app",
    ["analyst", "developer", "qa"],
  );
  assert.deepEqual(w, []);
});

test("flags an unknown assignee", () => {
  const w = validatePlan([{ title: "t", assignee: "ghost" }], "note something down", ["bob"]);
  assert.deepEqual(w, ['task "t" is assigned to "ghost", who is not on the team']);
});

test("flags reviewedBy == assignee", () => {
  const w = validatePlan([{ title: "t", assignee: "bob", reviewedBy: "bob" }], "x", ["bob"]);
  assert.ok(w.some((s) => /reviewedBy == assignee/.test(s)));
});

test("flags duplicate titles (case-insensitive)", () => {
  const w = validatePlan(
    [
      { title: "Build It", assignee: "bob" },
      { title: "build it", assignee: "bob" },
    ],
    "x",
    ["bob"],
  );
  assert.ok(w.some((s) => /duplicate task title/.test(s)));
});

test("flags a dependsOn that names no task in the plan", () => {
  const w = validatePlan([{ title: "build", assignee: "bob", dependsOn: ["the spec"] }], "x", [
    "bob",
  ]);
  assert.ok(w.some((s) => /dependsOn "the spec"/.test(s)));
});

test("flags a build goal with no developer task", () => {
  const w = validatePlan([{ title: "write docs", assignee: "writer" }], "build a snake game", [
    "writer",
  ]);
  assert.ok(w.some((s) => /no task went to a developer/.test(s)));
});

test("a non-build goal is not expected to have a developer task", () => {
  const w = validatePlan(
    [{ title: "research options", assignee: "researcher" }],
    "compare three approaches and write notes",
    ["researcher"],
  );
  assert.deepEqual(w, []);
});
