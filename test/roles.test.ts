import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { ROLES, hireableRoles } from "../src/agents/roles.ts";
import { toolsetFor, type ToolsetDeps } from "../src/tools/toolsets.ts";
import type { Tool } from "../src/tools/index.ts";

const stub = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  run: async () => "ok",
});

const deps: ToolsetDeps = {
  memoryTools: [stub("remember"), stub("recall")],
  mcpTools: [stub("srv__thing")],
  assignTask: stub("assign_task"),
  hireAgent: stub("hire_agent"),
  dismissAgent: stub("dismiss_agent"),
};
const names = (set: Parameters<typeof toolsetFor>[0]) => toolsetFor(set, deps).map((t) => t.name);

test("every role has a prompt, a toolset and writeRoots", () => {
  for (const [key, r] of Object.entries(ROLES)) {
    assert.ok(r.systemPrompt.length > 20, `${key} systemPrompt`);
    assert.ok(r.role && r.blurb, `${key} labels`);
    assert.ok(Array.isArray(r.writeRoots), `${key} writeRoots`);
  }
  assert.equal(ROLES.manager.writeRoots.length, 0, "manager is read-only");
});

test("hireableRoles excludes the manager", () => {
  assert.ok(!hireableRoles().includes("manager"));
  assert.ok(hireableRoles().includes("qa"));
  assert.ok(hireableRoles().includes("developer"));
});

test("reader toolset can list/read but never write or shell", () => {
  const t = names("reader");
  assert.ok(t.includes("list_files") && t.includes("read_file"));
  assert.ok(!t.includes("write_file") && !t.includes("append_file"));
  assert.ok(!t.includes("run_shell"));
  assert.ok(t.includes("recall")); // memory + mcp still available
  assert.ok(t.includes("srv__thing"));
});

test("writer toolset has file writing, no shell", () => {
  const t = names("writer");
  assert.ok(t.includes("write_file") && t.includes("append_file"));
  assert.ok(!t.includes("run_shell"));
});

test("developer toolset gates run_shell on OFFICE_ALLOW_SHELL", () => {
  assert.equal(names("developer").includes("run_shell"), config.allowShell);
});

test("manager toolset is delegation + hiring + memory only (no file tools)", () => {
  const t = names("manager");
  assert.deepEqual(
    t.filter((n) => ["assign_task", "hire_agent", "dismiss_agent"].includes(n)).sort(),
    ["assign_task", "dismiss_agent", "hire_agent"],
  );
  assert.ok(!t.includes("write_file") && !t.includes("run_shell") && !t.includes("read_file"));
});
