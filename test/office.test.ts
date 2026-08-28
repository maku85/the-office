import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Office } from "../src/orchestrator/office.ts";
import { makeAssignTask } from "../src/tools/assign.ts";
import type { AgentLike } from "../src/agents/agent.ts";
import type { GoalUpdateEvent, TaskUpdateEvent } from "../src/shared/events.ts";
import type { Bus } from "../src/orchestrator/bus.ts";
import { config } from "../src/config.ts";
import { recordingBus, tick } from "./helpers.ts";

interface PlanItem {
  to: string;
  title: string;
  reviewedBy?: string;
  skills?: string[];
}

/** Manager that enqueues its plan on planning/nudge turns, and gives a short
 *  reply on any other turn (check-in, review, question, …). */
function fakeManager(office: Office, plan: PlanItem[]): AgentLike {
  const isPlanning = (p: string) =>
    /A new goal has come in|assigned them nothing|no task is marked for review/.test(p);
  return {
    id: "carol",
    describe: () => "carol (manager)",
    async runTask(prompt) {
      if (isPlanning(prompt)) {
        for (const p of plan) {
          office.enqueue({
            title: p.title,
            details: "do it",
            assignee: p.to,
            reviewedBy: p.reviewedBy,
            skills: p.skills,
          });
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

/** Reviewer that reads a verdict script (last entry repeats). */
function fakeReviewer(office: Office, script: Array<"approve" | "changes">): AgentLike {
  let i = 0;
  return {
    id: "qa",
    describe: () => "qa (reviewer)",
    async runTask() {
      const v = script[Math.min(i, script.length - 1)];
      i++;
      office.recordReview(v, v === "changes" ? `fix round ${i}` : undefined);
      return "reviewed";
    },
  };
}

const taskStatuses = (events: unknown[]): string[] =>
  (events as TaskUpdateEvent[]).filter((e) => e.type === "task_update").map((e) => e.status);

const sysEvent = (over: { cpu?: number; memUsedMB?: number; load1?: number } = {}) => ({
  type: "system" as const,
  cpu: over.cpu ?? 5,
  cores: 10,
  load: [over.load1 ?? 1, 1, 1] as [number, number, number],
  memUsedMB: over.memUsedMB ?? 8_000,
  memTotalMB: 16_000,
  procRssMB: 50,
  swapUsedMB: 0,
  swapTotalMB: 4_000,
  tempC: null,
  models: [],
  platform: "test",
  uptimeS: 1,
});

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

  // fill to the configured cap
  for (const id of ["b", "c", "d", "e", "f", "g"]) {
    try {
      office.hire(id, "qa");
    } catch {
      // once the cap is hit, the next hire must be a "hire limit" error
      assert.throws(() => office.hire("z", "qa"), /hire limit/);
      return;
    }
  }
  assert.fail("hire cap was never reached");
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

  const out = await makeHireTeam(office).run({ template: "web" }, {} as never);
  assert.match(out, /developer/);
  assert.match(out, /qa/);
  assert.deepEqual(
    built.map((b) => b.roleKey).sort(),
    ["analyst", "designer", "developer", "qa"],
  );

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

test("assign_task pins a board card and holds no hand-off conversation", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  office.setTeam({ manager: fakeManager(office, []), workers: [fakeWorker("bob", [])] });

  const tool = makeAssignTask(office);
  const out = await tool.run(
    { to: "bob", title: "build the thing", details: "do it well" },
    { agent: "carol", bus } as never,
  );

  assert.match(out as string, /assigned "build the thing" to bob/);
  const board = events.filter((e) => e.type === "board") as Array<{ phase: string; by: string; task: string }>;
  assert.deepEqual(board, [{ type: "board", phase: "post", by: "carol", task: "build the thing" }] as never);
  assert.ok(!events.some((e) => e.type === "meeting"), "no meeting is staged");
  assert.ok(!events.some((e) => e.type === "agent_message"), "no hand-off message");
});

test("a worker claims a board card, then moves it to done", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "ship" }]),
    workers: [fakeWorker("bob", [])],
  });

  office.submitGoal("g");
  await tick(120);

  const phases = (events.filter((e) => e.type === "board") as Array<{ phase: string; by: string }>)
    .filter((e) => e.by === "bob")
    .map((e) => e.phase);
  assert.deepEqual(phases, ["claim", "done"]);
});

test("the smoke gate sends a broken page back, then fails the task past maxRevisions", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const dir = `demo-smoke-${Date.now()}`;
  const file = path.join(config.workspace, "projects", dir, "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let attempts = 0;
  const dev: AgentLike = {
    id: "bob",
    describe: () => "bob (worker)",
    async runTask() {
      attempts++;
      fs.writeFileSync(
        file,
        `<!doctype html><body><script>window.onload=()=>missingVar.doThing();</script></body>`,
      );
      return "wrote the page";
    },
  };
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "build the page" }]),
    workers: [dev],
  });

  try {
    office.submitGoal("smoke goal");
    await tick(150);

    assert.equal(attempts, config.maxRevisions + 1, "one initial run + maxRevisions reworks");
    const statuses = (events as TaskUpdateEvent[])
      .filter((e) => e.type === "task_update" && e.title === "build the page")
      .map((e) => e.status);
    assert.equal(statuses.at(-1), "failed");
    assert.ok(events.some((e) => e.type === "review" && e.by === "smoke" && e.verdict === "changes"));
    assert.deepEqual(statusesFor(events, "smoke goal").at(-1), "failed");
  } finally {
    fs.rmSync(path.join(config.workspace, "projects", dir), { recursive: true, force: true });
  }
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

test("review loop: reviewer requests changes once, then approves — worker runs twice", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const bobLog: string[] = [];
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "build it", reviewedBy: "qa" }]),
    workers: [fakeWorker("bob", bobLog), fakeReviewer(office, ["changes", "approve"])],
  });

  office.submitGoal("g");
  await tick(150);

  assert.equal(bobLog.length, 2, "one rework");
  const reviews = events.filter((e) => e.type === "review") as Array<{ verdict: string }>;
  assert.deepEqual(reviews.map((r) => r.verdict), ["changes", "approve"]);
  const st = taskStatuses(events);
  assert.ok(st.includes("reviewing") && st.includes("revision"));
  assert.equal(st.at(-1), "done");
});

test("review loop: a reviewer that keeps rejecting is capped at maxRevisions", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const bobLog: string[] = [];
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "build", reviewedBy: "qa" }]),
    workers: [fakeWorker("bob", bobLog), fakeReviewer(office, ["changes"])],
  });

  office.submitGoal("g");
  await tick(200);

  assert.equal(bobLog.length, 1 + config.maxRevisions, "first attempt + capped reworks");
  assert.equal(taskStatuses(events).at(-1), "done", "accepted after the cap");
});

test("review loop: a reviewer that never submits a verdict counts as approve", async () => {
  const { bus } = recordingBus();
  const office = new Office(bus, null, null);
  const bobLog: string[] = [];
  const silent: AgentLike = { id: "qa", describe: () => "qa", async runTask() { return "…"; } };
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "x", reviewedBy: "qa" }]),
    workers: [fakeWorker("bob", bobLog), silent],
  });

  office.submitGoal("g");
  await tick(120);
  assert.equal(bobLog.length, 1);
});

test("re-assigning the same (assignee, title) updates the task instead of duplicating it", async () => {
  const { bus } = recordingBus();
  const office = new Office(bus, null, null);
  const seen: string[] = [];
  office.setTeam({
    manager: {
      id: "carol",
      describe: () => "carol",
      async runTask(p) {
        if (/A new goal has come in/.test(p)) {
          const a = office.enqueue({ title: "T", details: "v1", assignee: "bob" });
          const b = office.enqueue({ title: "T", details: "v2", assignee: "bob", reviewedBy: "qa" });
          seen.push(a.id === b.id ? "same" : "diff", b.details, b.reviewedBy ?? "-");
          return "planned";
        }
        return "ok";
      },
    },
    workers: [fakeWorker("bob", [])],
  });

  office.submitGoal("g");
  await tick(100);
  assert.deepEqual(seen, ["same", "v2", "qa"]);
});

test("assign_task is ignored once the planning window is closed", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  office.setTeam({
    manager: {
      id: "carol",
      describe: () => "carol",
      async runTask(p) {
        if (/A new goal has come in/.test(p)) {
          office.enqueue({ title: "real", details: "d", assignee: "bob" });
          return "planned";
        }
        // a later turn tries to sneak in another task
        office.enqueue({ title: "sneaky", details: "d", assignee: "bob" });
        return "ok";
      },
    },
    workers: [fakeWorker("bob", [])],
  });

  office.submitGoal("g");
  await tick(120);

  const titles = (events as TaskUpdateEvent[])
    .filter((e) => e.type === "task_update")
    .map((e) => e.title);
  assert.ok(titles.includes("real"));
  assert.ok(!titles.includes("sneaky"));
  assert.ok(events.some((e) => e.type === "log" && /planning for this goal is closed/.test(e.text)));
});

test("review nudge: manager is prompted when a hire exists but no task is reviewed", async () => {
  const { bus } = recordingBus();
  const office = new Office(bus, null, null);
  const bobLog: string[] = [];
  const prompts: string[] = [];
  let planned = false;
  const mgr: AgentLike = {
    id: "carol",
    describe: () => "carol",
    async runTask(p) {
      prompts.push(p);
      if (!planned) {
        planned = true;
        office.hire("qa", "qa");
        office.enqueue({ title: "build", details: "d", assignee: "bob" });
        return "planned";
      }
      if (/no task is marked for review/.test(p)) {
        office.enqueue({ title: "build", details: "d", assignee: "bob", reviewedBy: "qa" });
        return "added review";
      }
      return "report";
    },
  };
  office.enableHiring(fakeHiring(bus, []));
  office.setTeam({ manager: mgr, workers: [fakeWorker("bob", bobLog)] });

  office.submitGoal("g");
  await tick(150);

  assert.ok(prompts.some((p) => /no task is marked for review/.test(p)), "review nudge fired");
});

test("review loop: reviewedBy equal to the assignee is ignored", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const bobLog: string[] = [];
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "y", reviewedBy: "bob" }]),
    workers: [fakeWorker("bob", bobLog)],
  });

  office.submitGoal("g");
  await tick(100);
  assert.equal(bobLog.length, 1);
  assert.ok(!events.some((e) => e.type === "review"));
});

test("load adapt: a task pauses while the machine is pegged, resumes when it recovers", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const bobLog: string[] = [];
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "t" }]),
    workers: [fakeWorker("bob", bobLog)],
  });

  bus.emit(sysEvent({ cpu: 99 })); // machine pegged
  office.submitGoal("g");
  await tick(40);

  assert.ok(
    events.some((e) => e.type === "cooldown" && e.active && /CPU/.test(e.reason)),
    "went on cooldown",
  );
  assert.equal(bobLog.length, 0, "worker has not started");

  bus.emit(sysEvent({ cpu: 5 })); // machine recovers
  await tick(40);

  const cooldowns = events.filter((e) => e.type === "cooldown") as Array<{ active: boolean; keep: string[] }>;
  assert.deepEqual(cooldowns.map((c) => c.active), [true, false]);
  assert.deepEqual([...cooldowns[0].keep].sort(), ["bob", "carol"]);
  assert.equal(bobLog.length, 1, "worker ran after recovery");
});

test("a task's tagged skills are folded into the worker's prompt", async () => {
  const { bus } = recordingBus();
  const fakeSkills = {
    all: [{ name: "x", description: "d", roles: [], keywords: [], body: "SKILL_BODY_XYZ", dir: "" }],
    get: (n: string) => (n === "x" ? fakeSkills.all[0] : undefined),
    index: () => "- x — d",
    resolve: (names?: string[]) =>
      names?.includes("x") ? "# Skill: x\nSKILL_BODY_XYZ" : "",
  };
  const office = new Office(bus, null, null, fakeSkills as never);
  let seenPrompt = "";
  const bob: AgentLike = {
    id: "bob",
    describe: () => "bob",
    async runTask(p) {
      seenPrompt = p;
      return "done";
    },
  };
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "t", skills: ["x"] }]),
    workers: [bob],
  });

  office.submitGoal("g");
  await tick(60);
  assert.match(seenPrompt, /SKILL_BODY_XYZ/);
});

test("load adapt: no system stats means no cooldown", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const bobLog: string[] = [];
  office.setTeam({
    manager: fakeManager(office, [{ to: "bob", title: "t" }]),
    workers: [fakeWorker("bob", bobLog)],
  });

  office.submitGoal("g");
  await tick(60);

  assert.ok(!events.some((e) => e.type === "cooldown"));
  assert.equal(bobLog.length, 1);
});

test("blank goal text is ignored", () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  office.setTeam({ manager: fakeManager(office, []), workers: [] });
  office.submitGoal("   ");
  assert.equal(events.length, 0);
});
