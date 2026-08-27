import { randomUUID } from "node:crypto";
import type { Bus } from "./bus.ts";
import type { AgentLike } from "../agents/agent.ts";
import type { TaskStatus } from "../shared/events.ts";
import { Memory, formatMemories } from "./memory.ts";
import { Vcs, slugify } from "./vcs.ts";
import {
  planningPrompt,
  assignmentNudge,
  workerPrompt,
  reviewPrompt,
} from "../agents/prompts.ts";
import { config } from "../config.ts";

export interface Task {
  id: string;
  title: string;
  details: string;
  assignee: string;
  status: TaskStatus;
  result?: string;
}

interface Goal {
  id: string;
  text: string;
  status: TaskStatus;
  commit?: string;
}

export type HireFactory = (opts: {
  id: string;
  roleKey: string;
  desk: string;
  focus?: string;
}) => AgentLike & { register(): void };

/** Desks the office UI keeps free for hired agents. */
export const HIRE_DESKS = ["hire_1", "hire_2", "hire_3", "hire_4", "hire_5", "hire_6"];

/**
 * Coordinates a manager and a set of workers around one goal:
 *   1. the manager plans and calls assign_task -> tasks land in the queue
 *   2. workers run their tasks one at a time (one model in memory on 18 GB)
 *   3. the manager reviews all results and writes a status report
 */
export class Office {
  readonly bus: Bus;
  private readonly memory: Memory | null;
  private readonly vcs: Vcs | null;
  private manager: AgentLike | null = null;
  private workers = new Map<string, AgentLike>();
  private queue: Task[] = [];
  private goals: Goal[] = [];
  private running = false;
  private hireFactory: HireFactory | null = null;
  private readonly hired = new Map<string, string>(); // id -> desk

  constructor(bus: Bus, memory: Memory | null = null, vcs: Vcs | null = null) {
    this.bus = bus;
    this.memory = memory;
    this.vcs = vcs;
  }

  /** Public entry point: queue a goal and process the backlog in order. */
  submitGoal(text: string): void {
    const goal: Goal = { id: randomUUID(), text: text.trim(), status: "queued" };
    if (!goal.text) return;
    this.goals.push(goal);
    this.emitGoal(goal);
    void this.pump();
  }

  private emitGoal(goal: Goal): void {
    this.bus.emit({
      type: "goal_update",
      goalId: goal.id,
      text: goal.text,
      status: goal.status,
      commit: goal.commit,
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const goal = this.goals.find((g) => g.status === "queued");
    if (!goal) return;
    this.running = true;
    goal.status = "active";
    this.emitGoal(goal);
    try {
      const ok = await this.runGoal(goal);
      goal.status = ok ? "done" : "failed";
    } catch (err) {
      goal.status = "failed";
      this.bus.emit({ type: "log", level: "error", text: String((err as Error).message) });
      await this.vcs?.abandonGoal(goal.id, config.keepFailedBranches);
    } finally {
      this.emitGoal(goal);
      this.running = false;
      void this.pump();
    }
  }

  /** Revert a merged goal. Wired to the "undo" button in the UI. */
  async undoGoal(goalId: string): Promise<void> {
    const goal = this.goals.find((g) => g.id === goalId);
    if (!goal?.commit || !this.vcs) {
      this.bus.emit({ type: "log", level: "warn", text: "nothing to undo for that goal" });
      return;
    }
    const ok = await this.vcs.revert(goal.commit);
    this.bus.emit({
      type: "log",
      level: ok ? "info" : "warn",
      text: ok
        ? `undid goal "${goal.text.slice(0, 60)}" (revert of ${goal.commit})`
        : `could not revert ${goal.commit} — conflicts`,
    });
  }

  private async recallBlock(query: string): Promise<string> {
    if (!this.memory) return "";
    try {
      return formatMemories(await this.memory.recall(query, config.recallK));
    } catch {
      return "";
    }
  }

  setTeam(team: { manager: AgentLike; workers: AgentLike[] }): void {
    this.manager = team.manager;
    this.workers = new Map(team.workers.map((w) => [w.id, w]));
  }

  /** Provide the factory the `hire_agent` tool uses to spawn specialists. */
  enableHiring(factory: HireFactory): void {
    this.hireFactory = factory;
  }

  get workerIds(): string[] {
    return [...this.workers.keys()];
  }

  private freeHireDesk(): string {
    return HIRE_DESKS.find((d) => ![...this.hired.values()].includes(d)) ?? "hire_1";
  }

  /** Bring a specialist onto the team at runtime. */
  hire(id: string, roleKey: string, focus?: string): AgentLike {
    if (!this.hireFactory) throw new Error("hiring is not enabled");
    id = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!id) throw new Error("a non-empty id is required");
    if (id === this.manager?.id || this.workers.has(id)) {
      throw new Error(`"${id}" is already on the team`);
    }
    if (this.hired.size >= config.maxHires) {
      throw new Error(`hire limit reached (OFFICE_MAX_HIRES=${config.maxHires})`);
    }
    const desk = this.freeHireDesk();
    const agent = this.hireFactory({ id, roleKey, desk, focus });
    this.workers.set(id, agent);
    this.hired.set(id, desk);
    agent.register();
    this.bus.emit({ type: "log", level: "info", text: `hired ${id} as ${roleKey}` });
    return agent;
  }

  /** Remove a hired agent (seed agents cannot be dismissed). */
  dismiss(id: string): void {
    if (!this.hired.has(id)) throw new Error(`"${id}" was not a hire`);
    this.workers.delete(id);
    this.hired.delete(id);
    this.bus.emit({ type: "agent_dismissed", agent: id });
    this.bus.emit({ type: "log", level: "info", text: `dismissed ${id}` });
  }

  private teamDirectory(): string {
    return [...this.workers.values()].map((w) => `- ${w.describe()}`).join("\n");
  }

  /** Called by the assign_task tool while the manager is planning. */
  enqueue(input: { title: string; details: string; assignee: string }): Task {
    const task: Task = {
      id: randomUUID(),
      status: "queued",
      title: input.title,
      details: input.details,
      assignee: input.assignee,
    };
    this.queue.push(task);
    this.emitTask(task);
    return task;
  }

  private emitTask(task: Task): void {
    this.bus.emit({
      type: "task_update",
      taskId: task.id,
      title: task.title,
      assignee: task.assignee,
      status: task.status,
      result: task.result?.slice(0, 300),
    });
  }

  /** Run one goal: plan → execute tasks → review → merge. Returns false if
   *  the manager assigned nothing or any task failed. */
  private async runGoal(goal: Goal): Promise<boolean> {
    if (!this.manager) throw new Error("office has no team");
    this.queue = [];
    this.bus.emit({ type: "log", level: "info", text: `goal: ${goal.text}` });

    // isolated worktree for this goal (or the shared workspace if VCS is off)
    const tree = this.vcs
      ? await this.vcs.startGoal(goal.id, slugify(goal.text))
      : config.workspace;

    // 1. plan — seed the manager with what the office already knows
    const planContext = this.memory ? formatMemories(this.memory.blackboard(12)) : "";
    await this.manager.runTask(planningPrompt(goal.text, this.teamDirectory(), planContext));
    this.bus.emit({ type: "agent_state", agent: this.manager.id, state: "idle" });

    // 1b. if the manager hired specialists but queued them no work, prompt once more
    const idleHires = [...this.hired.keys()].filter(
      (id) => !this.queue.some((t) => t.assignee === id),
    );
    if (idleHires.length) {
      await this.manager.runTask(assignmentNudge(idleHires));
      this.bus.emit({ type: "agent_state", agent: this.manager.id, state: "idle" });
    }

    if (this.queue.length === 0) {
      this.bus.emit({ type: "log", level: "warn", text: "goal failed: manager assigned no tasks" });
      await this.vcs?.abandonGoal(goal.id, config.keepFailedBranches);
      return false;
    }

    // 2. execute, sequentially, inside the worktree
    let failures = 0;
    for (const task of this.queue) {
      const worker = this.workers.get(task.assignee);
      if (!worker) {
        task.status = "failed";
        task.result = `no worker named "${task.assignee}"`;
        failures++;
        this.emitTask(task);
        continue;
      }
      task.status = "active";
      this.emitTask(task);
      try {
        const context = await this.recallBlock(`${task.title}\n${task.details}`);
        task.result = await worker.runTask(workerPrompt(task, context), tree);
        task.status = "done";
        await this.vcs?.commitTask(goal.id, task.assignee, task.title);
        await this.memory?.remember({
          kind: "note",
          agent: task.assignee,
          text: `[${task.title}] ${task.result}`.slice(0, 1000),
        });
      } catch (err) {
        task.status = "failed";
        task.result = String((err as Error).message);
        failures++;
        this.bus.emit({
          type: "log",
          agent: task.assignee,
          level: "error",
          text: `task failed: ${task.title} — ${task.result}`,
        });
      }
      this.emitTask(task);
    }

    // 3. review
    const reviewContext = await this.recallBlock(goal.text);
    const report = await this.manager.runTask(
      reviewPrompt(goal.text, this.queue, reviewContext),
    );
    this.bus.emit({ type: "agent_state", agent: this.manager.id, state: "idle" });
    await this.memory?.remember({
      kind: "decision",
      agent: this.manager.id,
      text: `Goal "${goal.text}" (${failures ? `${failures} task(s) failed` : "ok"}) — ${report}`.slice(0, 1000),
    });

    // 4. commit the goal — merge whatever succeeded, keep the branch if it failed
    if (this.vcs) {
      if (failures === 0) {
        const { merged, commit } = await this.vcs.finishGoal(goal.id, goal.text);
        if (merged) goal.commit = commit;
      } else {
        this.bus.emit({
          type: "log",
          level: "warn",
          text: `goal had ${failures} failed task(s) — branch kept, not merged`,
        });
        await this.vcs.abandonGoal(goal.id, true);
      }
    }

    // 5. send the hired specialists home, unless told to keep them
    if (!config.keepHires) {
      for (const id of [...this.hired.keys()]) this.dismiss(id);
    }
    return failures === 0;
  }
}
