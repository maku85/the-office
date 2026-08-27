import { test } from "node:test";
import assert from "node:assert/strict";
import { Office } from "../src/orchestrator/office.ts";
import type { AgentLike } from "../src/agents/agent.ts";
import type { GoalUpdateEvent, TaskUpdateEvent } from "../src/shared/events.ts";
import type { Bus } from "../src/orchestrator/bus.ts";
import { recordingBus, tick } from "./helpers.ts";

/** Manager whose first turn enqueues a fixed plan, later turns "review". */
function fakeManager(
  office: Office,
  plan: Array<{ to: string; title: string }>,
): AgentLike {
  // Office calls the manager exactly twice per goal: plan, then review.
  let turn = 0;
  return {
    id: "carol",
    describe: () => "carol (manager)",
    async runTask() {
      const isPlanningTurn = turn++ % 2 === 0;
      if (isPlanningTurn) {
        for (const p of plan) {
          office.enqueue({ title: p.title, details: "do it", assignee: p.to });
        }
        return "planned";
      }
      return "status report";
    },
  };
}

function fakeWorker(id: string, log: string[]): AgentLike {
  return {
    id,
    describe: () => `${id} (worker)`,
    async runTask(task) {
      log.push(`${id}:${task.slice(0, 12)}`);
      return `${id} finished`;
    },
  };
}

const statusesFor = (events: unknown[], text: string): string[] =>
  (events as GoalUpdateEvent[])
    .filter((e) => e.type === "goal_update" && e.text === text)
    .map((e) => e.status);

/** A hire factory that records what it built and registers like a real Agent. */
function fakeHiring(bus: Bus, built: Array<{ id: string; roleKey: string; desk: string }>) {
  return (opts: { id: string; roleKey: string; desk: string; focus?: string }) => {
    built.push({ id: opts.id, roleKey: opts.roleKey, desk: opts.desk });
    return {
      id: opts.id,
      describe: () => `${opts.id} (${opts.roleKey})`,
      register: () =>
        bus.emit({ type: "agent_registered", agent: opts.id, role: opts.roleKey, desk: opts.desk }),
      async runTask() {
        return `${opts.id} finished`;
      },
    };
  };
}

test("hire adds a worker with a hire desk; dismiss removes it", () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const built: Array<{ id: string; roleKey: string; desk: string }> = [];
  office.enableHiring(fakeHiring(bus, built));
  office.setTeam({ manager: fakeManager(office, []), workers: [] });

  const agent = office.hire("Dana!", "qa");
  assert.equal(agent.id, "dana"); // sanitised
  assert.ok(office.workerIds.includes("dana"));
  assert.match(built[0].desk, /^hire_\d$/);
  assert.ok(events.some((e) => e.type === "agent_registered" && e.agent === "dana"));

  office.dismiss("dana");
  assert.ok(!office.workerIds.includes("dana"));
  assert.ok(events.some((e) => e.type === "agent_dismissed" && e.agent === "dana"));
});

test("hire rejects duplicates, unknown-not-checked ids stack on free desks, respects the cap", () => {
  const { bus } = recordingBus();
  const office = new Office(bus, null, null);
  office.enableHiring(fakeHiring(bus, []));
  office.setTeam({ manager: fakeManager(office, []), workers: [] });

  office.hire("a", "qa");
  assert.throws(() => office.hire("a", "writer"), /already on the team/);
  assert.throws(() => office.hire("carol", "qa"), /already on the team/);

  // fill to the configured cap (default 4)
  office.hire("b", "qa");
  office.hire("c", "qa");
  office.hire("d", "qa");
  assert.throws(() => office.hire("e", "qa"), /hire limit/);
});

test("dismiss refuses to remove a seed team member", () => {
  const { bus } = recordingBus();
  const office = new Office(bus, null, null);
  const seenLog: string[] = [];
  office.enableHiring(fakeHiring(bus, []));
  office.setTeam({ manager: fakeManager(office, []), workers: [fakeWorker("bob", seenLog)] });
  assert.throws(() => office.dismiss("bob"), /was not a hire/);
});

test("hire_team staffs the template's specialist roles", async () => {
  const { makeHireTeam } = await import("../src/tools/hiring.ts");
  const { bus } = recordingBus();
  const office = new Office(bus, null, null);
  const built: Array<{ id: string; roleKey: string; desk: string }> = [];
  office.enableHiring(fakeHiring(bus, built));
  office.setTeam({ manager: fakeManager(office, []), workers: [] });

  const out = await makeHireTeam(office).run({ template: "software" }, {} as never);
  assert.match(out, /designer/);
  assert.match(out, /qa/);
  assert.deepEqual(built.map((b) => b.roleKey).sort(), ["designer", "qa"]);

  const bad = await makeHireTeam(office).run({ template: "nope" }, {} as never);
  assert.match(bad, /unknown template/);
});

test("goals run one at a time; a goal submitted while busy is queued, not dropped", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const workerLog: string[] = [];
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "task-a" }]),
    workers: [fakeWorker("bob", workerLog)],
  });

  office.submitGoal("goal one");
  office.submitGoal("goal two");
  await tick();

  assert.deepEqual(statusesFor(events, "goal one"), ["queued", "active", "done"]);
  assert.deepEqual(statusesFor(events, "goal two"), ["queued", "active", "done"]);
  assert.equal(workerLog.length, 2, "both goals ran their worker");

  const updates = events.filter((e) => e.type === "goal_update") as GoalUpdateEvent[];
  const oneDone = updates.findIndex((e) => e.text === "goal one" && e.status === "done");
  const twoActive = updates.findIndex((e) => e.text === "goal two" && e.status === "active");
  assert.ok(oneDone < twoActive, "goal two only started after goal one finished");
});

test("tasks are dispatched to the assigned worker", async () => {
  const { bus } = recordingBus();
  const office = new Office(bus, null, null);
  const aliceLog: string[] = [];
  const bobLog: string[] = [];
  office.setTeam({
    manager: fakeManager(office, [
      { to: "alice", title: "research" },
      { to: "bob", title: "implement" },
    ]),
    workers: [fakeWorker("alice", aliceLog), fakeWorker("bob", bobLog)],
  });

  office.submitGoal("ship it");
  await tick();

  assert.equal(aliceLog.length, 1);
  assert.equal(bobLog.length, 1);
});

test("a plan with no tasks fails the goal without invoking any worker", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const workerLog: string[] = [];
  office.setTeam({
    manager: fakeManager(office, []),
    workers: [fakeWorker("bob", workerLog)],
  });

  office.submitGoal("vague goal");
  await tick();

  assert.equal(workerLog.length, 0);
  assert.ok(
    events.some((e) => e.type === "log" && /assigned no tasks/.test(e.text)),
    "logs that nothing was assigned",
  );
  assert.deepEqual(statusesFor(events, "vague goal"), ["queued", "active", "failed"]);
});

test("a task that throws fails the goal but lets the other tasks run", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const aliceLog: string[] = [];
  const badBob: AgentLike = {
    id: "bob",
    describe: () => "bob (worker)",
    async runTask() {
      throw new Error("boom");
    },
  };
  office.setTeam({
    manager: fakeManager(office, [
      { to: "bob", title: "will fail" },
      { to: "alice", title: "will pass" },
    ]),
    workers: [badBob, fakeWorker("alice", aliceLog)],
  });

  office.submitGoal("mixed goal");
  await tick();

  assert.equal(aliceLog.length, 1, "alice still ran after bob failed");
  const taskStatuses = (events as TaskUpdateEvent[])
    .filter((e) => e.type === "task_update")
    .reduce<Record<string, string>>((acc, e) => ((acc[e.title] = e.status), acc), {});
  assert.equal(taskStatuses["will fail"], "failed");
  assert.equal(taskStatuses["will pass"], "done");
  assert.deepEqual(statusesFor(events, "mixed goal"), ["queued", "active", "failed"]);
});

test("blank goal text is ignored", () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  office.setTeam({ manager: fakeManager(office, []), workers: [] });
  office.submitGoal("   ");
  assert.equal(events.length, 0);
});
