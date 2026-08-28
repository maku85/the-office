import { randomUUID } from "node:crypto";
import type { Bus } from "./bus.ts";
import type { AgentLike } from "../agents/agent.ts";
import type { TaskStatus, SystemStatsEvent } from "../shared/events.ts";
import { Memory, formatMemories } from "./memory.ts";
import { Vcs, slugify } from "./vcs.ts";
import type { SkillRegistry } from "../skills/index.ts";
import {
  planningPrompt,
  assignmentNudge,
  reviewNudge,
  workerPrompt,
  reviewerPrompt,
  reviewPrompt,
  managerAnswerPrompt,
  checkInPrompt,
} from "../agents/prompts.ts";
import { config } from "../config.ts";

export interface Task {
  id: string;
  title: string;
  details: string;
  assignee: string;
  /** teammate who checks the output before it counts as done */
  reviewedBy?: string;
  /** skill names the manager tagged for this task */
  skills?: string[];
  /** rework cycles done so far */
  revisions: number;
  status: TaskStatus;
  result?: string;
}

type ReviewVerdict = { verdict: "approve" | "changes"; feedback?: string };

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
  private pendingReview: ReviewVerdict | null = null;
  private activeGoalText: string | null = null;
  private acceptingTasks = false;
  private askChain: Promise<unknown> = Promise.resolve();
  private lastStats: SystemStatsEvent | null = null;

  private readonly skills: SkillRegistry | null;

  constructor(
    bus: Bus,
    memory: Memory | null = null,
    vcs: Vcs | null = null,
    skills: SkillRegistry | null = null,
  ) {
    this.bus = bus;
    this.memory = memory;
    this.vcs = vcs;
    this.skills = skills;
    this.bus.onEvent((e) => {
      if (e.type === "system") this.lastStats = e;
    });
  }

  /** Is the machine over threshold? `scale` (<1) tightens it for resume checks. */
  private overloaded(scale = 1): { over: boolean; reason: string } {
    const s = this.lastStats;
    if (!config.loadAdapt || !s) return { over: false, reason: "" };
    const mem = s.memTotalMB ? s.memUsedMB / s.memTotalMB : 0;
    const load = s.cores ? s.load[0] / s.cores : 0;
    if (mem > config.memHigh * scale) return { over: true, reason: `RAM ${Math.round(mem * 100)}%` };
    if (s.cpu > config.cpuHigh * 100 * scale) return { over: true, reason: `CPU ${s.cpu}%` };
    if (load > config.loadHigh * scale)
      return { over: true, reason: `load ${s.load[0].toFixed(1)}/${s.cores}c` };
    return { over: false, reason: "" };
  }

  /** Block before an LLM turn while the machine is pegged — bounded by cooldownMaxMs. */
  private async awaitCapacity(keep: string[]): Promise<void> {
    const entry = this.overloaded(1);
    if (!entry.over) return;
    this.bus.emit({ type: "cooldown", active: true, reason: entry.reason, keep });
    this.bus.emit({
      type: "log",
      level: "warn",
      text: `machine under pressure (${entry.reason}) — team on break, one worker + manager stay`,
    });
    const started = Date.now();
    await new Promise<void>((resolve) => {
      let off = () => {};
      const done = () => {
        clearTimeout(cap);
        off();
        resolve();
      };
      const cap = setTimeout(done, config.cooldownMaxMs);
      off = this.bus.onEvent((e) => {
        if (e.type === "system" && !this.overloaded(config.cooldownResume).over) done();
      });
    });
    this.bus.emit({
      type: "cooldown",
      active: false,
      reason: "",
      keep,
    });
    this.bus.emit({
      type: "log",
      level: "info",
      text: `machine recovered — resuming after ${Math.round((Date.now() - started) / 1000)}s`,
    });
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
  enqueue(input: {
    title: string;
    details: string;
    assignee: string;
    reviewedBy?: string;
    skills?: string[];
  }): Task {
    // tasks can only be added while the manager is planning
    if (!this.acceptingTasks) {
      this.bus.emit({
        type: "log",
        level: "warn",
        text: `assign_task ignored — planning for this goal is closed`,
      });
      return {
        id: randomUUID(),
        status: "failed",
        title: input.title,
        details: input.details,
        assignee: input.assignee,
        revisions: 0,
      };
    }

    // a reviewer can't be the assignee
    const reviewedBy =
      input.reviewedBy && input.reviewedBy !== input.assignee ? input.reviewedBy : undefined;

    // re-assigning the same (assignee, title) updates the task rather than duping it
    const existing = this.queue.find(
      (t) => t.assignee === input.assignee && t.title === input.title && t.status === "queued",
    );
    if (existing) {
      existing.details = input.details;
      existing.reviewedBy = reviewedBy;
      existing.skills = input.skills;
      this.emitTask(existing);
      return existing;
    }

    const task: Task = {
      id: randomUUID(),
      status: "queued",
      title: input.title,
      details: input.details,
      assignee: input.assignee,
      reviewedBy,
      skills: input.skills,
      revisions: 0,
    };
    this.queue.push(task);
    this.emitTask(task);
    return task;
  }

  /** Recorded by the submit_review tool during a review turn. */
  recordReview(verdict: "approve" | "changes", feedback?: string): void {
    this.pendingReview = { verdict, feedback };
  }

  /** The ask_manager tool: a worker walks over and asks the manager something.
   *  Serialised — one conversation with the manager at a time (the "queue"). */
  answerQuestion(asker: string, question: string): Promise<string> {
    const run = this.askChain.then(async () => {
      if (!this.manager) return "the manager is not available right now";
      this.bus.emit({ type: "question", from: asker, text: question });
      this.bus.emit({ type: "meeting", participants: [asker, this.manager.id], topic: "question" });
      const answer = await this.manager.runTask(
        managerAnswerPrompt(this.activeGoalText ?? "(no active goal)", asker, question),
      );
      this.bus.emit({ type: "agent_state", agent: this.manager.id, state: "idle" });
      this.bus.emit({ type: "answer", to: asker, text: answer });
      return answer;
    });
    // keep the chain alive but don't let a failure wedge it
    this.askChain = run.catch(() => undefined);
    return run;
  }

  /** A short manager check-in after a task, folded back in as extra guidance. */
  private async checkIn(task: Task): Promise<void> {
    if (!this.manager || !config.checkIns) return;
    this.bus.emit({
      type: "meeting",
      participants: [this.manager.id, task.assignee],
      topic: `check-in: ${task.title}`,
    });
    const note = (await this.manager.runTask(checkInPrompt(task))).trim();
    this.bus.emit({ type: "agent_state", agent: this.manager.id, state: "idle" });
    if (note && note.length < 300) {
      this.bus.emit({
        type: "agent_message",
        agent: this.manager.id,
        target: task.assignee,
        text: note,
      });
    }
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

  /** Run a task through the worker, then (if it has a reviewer) a bounded
   *  worker → review → rework loop. Returns false on hard failure. */
  private async runOneTask(task: Task, goalId: string, goalText: string, tree: string): Promise<boolean> {
    const worker = this.workers.get(task.assignee);
    if (!worker) {
      task.status = "failed";
      task.result = `no worker named "${task.assignee}"`;
      this.emitTask(task);
      return false;
    }

    const keep = [this.manager?.id ?? "carol", task.assignee];
    let feedback: string | undefined;
    for (;;) {
      task.status = feedback ? "revision" : "active";
      this.emitTask(task);
      try {
        await this.awaitCapacity(keep);
        const context = await this.recallBlock(`${task.title}\n${task.details}`);
        const base = workerPrompt(task, context, this.skills?.resolve(task.skills) ?? "");
        const prompt = feedback
          ? `${base}\n\nYour previous attempt needs changes:\n${feedback}\n\nRevise it now.`
          : base;
        task.result = await worker.runTask(prompt, tree);
      } catch (err) {
        task.status = "failed";
        task.result = String((err as Error).message);
        this.bus.emit({
          type: "log",
          agent: task.assignee,
          level: "error",
          text: `task failed: ${task.title} — ${task.result}`,
        });
        this.emitTask(task);
        return false;
      }

      const reviewer = task.reviewedBy ? this.workers.get(task.reviewedBy) : undefined;
      if (!reviewer || task.revisions >= config.maxRevisions) break;

      task.status = "reviewing";
      this.emitTask(task);
      this.bus.emit({
        type: "meeting",
        participants: [task.assignee, task.reviewedBy!],
        topic: `review: ${task.title}`,
      });
      const { verdict, feedback: fb } = await this.runReview(reviewer, task, goalText, tree);
      this.bus.emit({ type: "review", task: task.title, by: task.reviewedBy!, verdict, feedback: fb });
      if (verdict === "approve") break;

      task.revisions++;
      feedback = fb || "Improve the work to fully meet the task.";
    }

    task.status = "done";
    this.emitTask(task);
    await this.vcs?.commitTask(goalId, task.assignee, task.title);
    await this.memory?.remember({
      kind: "note",
      agent: task.assignee,
      text: `[${task.title}] ${task.result}`.slice(0, 1000),
    });
    return true;
  }

  /** One review turn. A reviewer that errors or never submits counts as approve. */
  private async runReview(
    reviewer: AgentLike,
    task: Task,
    goalText: string,
    tree: string,
  ): Promise<ReviewVerdict> {
    this.pendingReview = null;
    try {
      await this.awaitCapacity([this.manager?.id ?? "carol", task.reviewedBy ?? reviewer.id]);
      await reviewer.runTask(reviewerPrompt(task, goalText), tree);
    } catch {
      return { verdict: "approve" };
    }
    const result = this.pendingReview ?? { verdict: "approve" as const };
    this.pendingReview = null;
    return result;
  }

  /** Run one goal: plan → execute tasks → review → merge. Returns false if
   *  the manager assigned nothing or any task failed. */
  private async runGoal(goal: Goal): Promise<boolean> {
    if (!this.manager) throw new Error("office has no team");
    this.queue = [];
    this.activeGoalText = goal.text;
    this.bus.emit({ type: "log", level: "info", text: `goal: ${goal.text}` });

    // isolated worktree for this goal (or the shared workspace if VCS is off)
    const tree = this.vcs
      ? await this.vcs.startGoal(goal.id, slugify(goal.text))
      : config.workspace;

    // 1. plan — seed the manager with what the office already knows
    this.acceptingTasks = true;
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

    // 1c. reviewers on the team but nothing set to be reviewed → prompt once
    if (this.hired.size > 0 && !this.queue.some((t) => t.reviewedBy)) {
      await this.manager.runTask(reviewNudge([...this.hired.keys()]));
      this.bus.emit({ type: "agent_state", agent: this.manager.id, state: "idle" });
    }

    this.acceptingTasks = false; // planning window closed

    if (this.queue.length === 0) {
      this.bus.emit({ type: "log", level: "warn", text: "goal failed: manager assigned no tasks" });
      await this.vcs?.abandonGoal(goal.id, config.keepFailedBranches);
      return false;
    }

    // 2. execute, sequentially, inside the worktree
    let failures = 0;
    for (const task of [...this.queue]) {
      const ok = await this.runOneTask(task, goal.id, goal.text, tree);
      if (!ok) failures++;
      await this.checkIn(task);
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

    // 5. send the hired specialists home — the office is back to just the manager
    if (!config.keepHires) {
      for (const id of [...this.hired.keys()]) this.dismiss(id);
    }
    this.activeGoalText = null;
    return failures === 0;
  }
}
