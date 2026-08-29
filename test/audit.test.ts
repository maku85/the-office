import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { AuditLog, type AuditRow } from "../src/orchestrator/audit.ts";
import { recordingBus, tmpDir } from "./helpers.ts";

async function freshAudit(): Promise<AuditLog> {
  const dir = await tmpDir("audit");
  return new AuditLog(path.join(dir, "audit.db"));
}

const detail = (r: AuditRow) => JSON.parse(r.detail) as Record<string, unknown>;

test("attach folds a curated slice of the event stream into rows", async () => {
  const { bus } = recordingBus();
  const audit = await freshAudit();
  audit.attach(bus);

  bus.emit({ type: "agent_registered", agent: "bob", role: "developer", desk: "hire_1", model: "cloud:x" });
  bus.emit({ type: "agent_state", agent: "bob", state: "working" }); // ignored (noise)
  bus.emit({ type: "tool_call", agent: "bob", tool: "write_file", args: {}, callId: "c1" }); // ignored
  bus.emit({ type: "task_update", taskId: "t1", title: "build", assignee: "bob", status: "active" }); // ignored (not terminal)
  bus.emit({ type: "task_update", taskId: "t1", title: "build", assignee: "bob", status: "done" });
  bus.emit({ type: "review", task: "build", by: "qa", verdict: "changes", feedback: "fix it" });
  bus.emit({ type: "usage", agent: "bob", model: "cloud:x", inputTokens: 120, outputTokens: 30, ms: 900, turns: 2 });
  bus.emit({
    type: "goal_update",
    goalId: "g1",
    text: "ship the thing",
    status: "done",
    usage: { inputTokens: 500, outputTokens: 90, ms: 4000 },
  });

  const rows = audit.recent();
  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(
    kinds.sort(),
    ["goal", "hire", "review", "task", "usage"],
    "only the audited events produced rows",
  );

  const goal = rows.find((r) => r.kind === "goal")!;
  assert.equal(goal.actor, "office");
  assert.equal(detail(goal).status, "done");
  assert.deepEqual(detail(goal).usage, { inputTokens: 500, outputTokens: 90, ms: 4000 });

  const review = rows.find((r) => r.kind === "review")!;
  assert.equal(review.actor, "qa");
  assert.equal(detail(review).verdict, "changes");

  audit.close();
});

test("recent() filters by kind and honours the limit; newest first", async () => {
  const { bus } = recordingBus();
  const audit = await freshAudit();
  audit.attach(bus);

  for (let i = 0; i < 5; i++) {
    bus.emit({ type: "goal_update", goalId: `g${i}`, text: `goal ${i}`, status: "done" });
    bus.emit({ type: "agent_dismissed", agent: `hire_${i}` });
  }

  const goals = audit.recent({ kind: "goal" });
  assert.equal(goals.length, 5);
  assert.ok(goals.every((r) => r.kind === "goal"));
  assert.equal(JSON.parse(goals[0].detail).goalId, "g4", "newest first");

  assert.equal(audit.recent({ limit: 3 }).length, 3);
  assert.equal(audit.recent().length, 10, "all rows without a filter");

  audit.close();
});

test("approval request + resolve are two rows with the right actors", async () => {
  const { bus } = recordingBus();
  const audit = await freshAudit();
  audit.attach(bus);

  bus.emit({ type: "approval_request", agent: "bob", requestId: "r1", action: "run_shell", detail: "rm -rf /" });
  bus.emit({ type: "approval_resolved", requestId: "r1", approved: false });

  const rows = audit.recent({ kind: "approval" });
  assert.equal(rows.length, 2);
  const resolved = rows.find((r) => JSON.parse(r.detail).decided === true)!;
  assert.equal(resolved.actor, "broker");
  assert.equal(JSON.parse(resolved.detail).approved, false);
  const requested = rows.find((r) => JSON.parse(r.detail).decided === false)!;
  assert.equal(requested.actor, "bob");

  audit.close();
});

test("close() is safe and stops recording", async () => {
  const { bus } = recordingBus();
  const audit = await freshAudit();
  audit.attach(bus);
  bus.emit({ type: "goal_update", goalId: "g1", text: "x", status: "done" });
  audit.close();
  audit.close(); // idempotent
  // detached: a later event must not throw or land
  assert.doesNotThrow(() =>
    bus.emit({ type: "goal_update", goalId: "g2", text: "y", status: "done" }),
  );
});
