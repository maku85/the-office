import { test } from "node:test";
import assert from "node:assert/strict";
import { Office } from "../src/orchestrator/office.ts";
import type { AgentLike } from "../src/agents/agent.ts";
import type { GoalUpdateEvent } from "../src/shared/events.ts";
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

test("a plan with no tasks finishes without invoking any worker", async () => {
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
  // NOTE: current behaviour marks an empty plan "done"; revisit if that should be "failed".
  assert.deepEqual(statusesFor(events, "vague goal"), ["queued", "active", "done"]);
});

test("blank goal text is ignored", () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  office.setTeam({ manager: fakeManager(office, []), workers: [] });
  office.submitGoal("   ");
  assert.equal(events.length, 0);
});
