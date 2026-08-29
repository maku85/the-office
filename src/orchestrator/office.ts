import { randomUUID } from "node:crypto";
import type { Bus } from "./bus.ts";
import type { AgentLike } from "../agents/agent.ts";
import type { TaskStatus, SystemStatsEvent, GoalUpdateEvent } from "../shared/events.ts";
import { Memory, formatMemories } from "./memory.ts";
import { Vcs, slugify } from "./vcs.ts";
import { smokeProject, formatSmoke } from "./smoke.ts";
import { lintProject, formatLint } from "./lint.ts";
import type { SkillRegistry } from "../skills/index.ts";
import { ROLES } from "../agents/roles.ts";
import {
  planningPrompt,
  assignmentNudge,
  reviewNudge,
  workerPrompt,
  reviewerPrompt,
  reviewPrompt,
  reflectionPrompt,
  parseLessons,
  managerAnswerPrompt,
  checkInPrompt,
} from "../agents/prompts.ts";
import { config } from "../config.ts";

export type TaskPriority = "low" | "normal" | "high";

export interface Task {
  id: string;
  title: string;
  details: string;
  assignee: string;
  /** teammate who checks the output before it counts as done */
  reviewedBy?: string;
  /** skill names the manager tagged for this task */
  skills?: string[];
  /** execution order within the goal (default "normal") */
  priority?: TaskPriority;
  /** titles of sibling tasks that must be `done` before this one runs */
  dependsOn?: string[];
  /** rework cycles done so far */
  revisions: number;
  status: TaskStatus;
  result?: string;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

type ReviewVerdict = { verdict: "approve" | "changes"; feedback?: string };

interface Goal {
  id: string;
  text: string;
  status: TaskStatus;
  commit?: string;
  usage?: GoalUpdateEvent["usage"];
}

export type HireFactory = (opts: {
  id: string;
  roleKey: string;
  desk: string;
  focus?: string;
}) => AgentLike & { register(): void };

/** Desks the office UI keeps free for hired agents. */
export const HIRE_DESKS = ["hire_1", "hire_2", "hire_3", "hire_4", "hire_5", "hire_6"];

/** Two work zones the UI draws. Heavy-tier roles (code / review / build) sit in
 *  `build`, everyone else in `plan`; a hire falls back to any free desk if its
 *  zone is full. Purely organisational — same desks, grouped by role. */
export const HIRE_ZONES = {
  build: ["hire_1", "hire_2", "hire_3"],
  plan: ["hire_4", "hire_5", "hire_6"],
} as const;

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
  /** per-model token tally for the goal currently running (null between goals) */
  private goalUsage: Map<string, { inTok: number; outTok: number }> | null = null;
  /** goals finished so far — drives the periodic reflection pass */
  private goalsCompleted = 0;
  /** one-shot LLM call for reflection (set via {@link enableReflection}) */
  private reflectChat: ((prompt: string) => Promise<string>) | null = null;

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
      if (e.type === "system") {
        this.lastStats = e;
      } else if (e.type === "usage" && this.goalUsage) {
        const m = this.goalUsage.get(e.model) ?? { inTok: 0, outTok: 0 };
        m.inTok += e.inputTokens;
        m.outTok += e.outputTokens;
        this.goalUsage.set(e.model, m);
      }
    });
  }

  /** Fold the goal's per-model tallies into one total + a cloud cost estimate. */
  private summariseUsage(ms: number): GoalUpdateEvent["usage"] {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    const byModel: Record<string, { inputTokens: number; outputTokens: number }> = {};
    for (const [model, u] of this.goalUsage ?? []) {
      inputTokens += u.inTok;
      outputTokens += u.outTok;
      byModel[model] = { inputTokens: u.inTok, outputTokens: u.outTok };
      const p = config.pricing[model] ?? config.pricing[model.replace(/^[a-z]+:/, "")];
      if (p) costUsd += (u.inTok / 1e6) * p.in + (u.outTok / 1e6) * p.out;
    }
    const usage: NonNullable<GoalUpdateEvent["usage"]> = { inputTokens, outputTokens, ms };
    if (Object.keys(config.pricing).length) usage.costUsd = Math.round(costUsd * 1e6) / 1e6;
    if (Object.keys(byModel).length > 1) usage.byModel = byModel; // only interesting on a failover
    return usage;
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
      usage: goal.usage,
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

  /** Wire the one-shot LLM call the periodic reflection pass uses to distil
   *  recent notes into durable insights. Without it, reflection is skipped. */
  enableReflection(chat: (prompt: string) => Promise<string>): void {
    this.reflectChat = chat;
  }

  get workerIds(): string[] {
    return [...this.workers.keys()];
  }

  private freeHireDesk(roleKey: string): string {
    const taken = new Set(this.hired.values());
    const zone = ROLES[roleKey]?.tier === "heavy" ? HIRE_ZONES.build : HIRE_ZONES.plan;
    return (
      zone.find((d) => !taken.has(d)) ??
      HIRE_DESKS.find((d) => !taken.has(d)) ??
      "hire_1"
    );
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
    const desk = this.freeHireDesk(roleKey);
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
    priority?: TaskPriority;
    dependsOn?: string[];
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
    const priority = input.priority ?? "normal";
    const dependsOn = input.dependsOn?.map((d) => d.trim()).filter(Boolean);

    if (existing) {
      existing.details = input.details;
      existing.reviewedBy = reviewedBy;
      existing.skills = input.skills;
      existing.priority = priority;
      existing.dependsOn = dependsOn;
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
      priority,
      dependsOn,
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

  /** A short manager check-in after a task — the manager just glances at the board. */
  private async checkIn(task: Task): Promise<void> {
    if (!this.manager || !config.checkIns) return;
    this.bus.emit({ type: "board", task: task.title, by: this.manager.id, phase: "check" });
    const note = (await this.manager.runTask(checkInPrompt(task))).trim();
    this.bus.emit({ type: "agent_state", agent: this.manager.id, state: "idle" });
    if (note && note.length < 300) {
      this.bus.emit({ type: "log", agent: this.manager.id, level: "info", text: note });
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
      priority: task.priority,
      dependsOn: task.dependsOn,
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
    // the worker walks to the board and takes the card
    this.bus.emit({ type: "board", task: task.title, by: task.assignee, phase: "claim" });
    const startedAt = Date.now();
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

      // deterministic gates: any web page must load without throwing, and any
      // script / JSON must parse. A failure is rework; past maxRevisions it
      // fails the task.
      const gateReport = this.runGates(task, tree, startedAt);
      if (gateReport) {
        if (task.revisions >= config.maxRevisions) {
          task.status = "failed";
          task.result = `deterministic checks still fail after ${task.revisions} revision(s):\n${gateReport}`;
          this.bus.emit({
            type: "log",
            agent: task.assignee,
            level: "error",
            text: `task failed (checks): ${task.title}`,
          });
          this.emitTask(task);
          return false;
        }
        task.revisions++;
        feedback = `Deterministic checks failed. Fix every one of these:\n${gateReport}`;
        continue;
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
    // the worker moves the card to Done
    this.bus.emit({ type: "board", task: task.title, by: task.assignee, phase: "done" });
    await this.vcs?.commitTask(goalId, task.assignee, task.title);
    await this.memory?.remember({
      kind: "note",
      agent: task.assignee,
      text: `[${task.title}] ${task.result}`.slice(0, 1000),
    });
    return true;
  }

  /** Run every deterministic post-task gate and join their rework reports.
   *  Returns null when everything passes (or a gate is off). Never throws. */
  private runGates(task: Task, tree: string, since: number): string | null {
    const reports: string[] = [];
    if (config.smoke) {
      const r = this.runSmoke(task, tree, since);
      if (r) reports.push(r);
    }
    if (config.lint) {
      const r = this.runLint(task, tree, since);
      if (r) reports.push(r);
    }
    return reports.length ? reports.join("\n\n") : null;
  }

  /** Syntax-check every JS / JSON the task just wrote. Returns a rework report
   *  if any file fails to parse, or null. Never throws. */
  private runLint(task: Task, tree: string, since: number): string | null {
    let failed: ReturnType<typeof lintProject>;
    try {
      failed = lintProject(tree, since).filter((r) => !r.ok);
    } catch (err) {
      this.bus.emit({ type: "log", level: "warn", text: `lint check skipped: ${(err as Error).message}` });
      return null;
    }
    if (!failed.length) return null;
    const report = formatLint(failed);
    this.bus.emit({ type: "review", task: task.title, by: "lint", verdict: "changes", feedback: report.slice(0, 300) });
    this.bus.emit({
      type: "log",
      agent: task.assignee,
      level: "warn",
      text: `lint check failed for "${task.title}" — sending back for rework`,
    });
    return report;
  }

  /** Load every HTML the task just wrote in a headless shim. Returns a rework
   *  report if any page throws on load, or null if they all run (or there are
   *  none). Never throws — a broken checker must not block the office. */
  private runSmoke(task: Task, tree: string, since: number): string | null {
    let failed: ReturnType<typeof smokeProject>;
    try {
      const wantsCanvas = /\bcanvas\b/i.test(`${task.title} ${task.details}`);
      failed = smokeProject(tree, since, { canvas: wantsCanvas }).filter((r) => !r.ok);
    } catch (err) {
      this.bus.emit({ type: "log", level: "warn", text: `smoke check skipped: ${(err as Error).message}` });
      return null;
    }
    if (!failed.length) return null;
    const report = formatSmoke(failed);
    this.bus.emit({ type: "review", task: task.title, by: "smoke", verdict: "changes", feedback: report.slice(0, 300) });
    this.bus.emit({
      type: "log",
      agent: task.assignee,
      level: "warn",
      text: `smoke check failed for "${task.title}" — sending back for rework`,
    });
    return report;
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
    this.goalUsage = new Map();
    const goalStart = Date.now();
    try {
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

    // 2. execute, sequentially — highest priority first, respecting dependsOn
    let failures = 0;
    const pending = [...this.queue];
    const finished = new Set<string>(); // lowercased titles of tasks that succeeded
    const depsMet = (t: Task) =>
      (t.dependsOn ?? []).every((d) => finished.has(d.toLowerCase()));

    while (pending.length) {
      const ready = pending.filter(depsMet);
      let task: Task;
      if (ready.length) {
        // best priority; ties keep queue order (filter + reduce are stable)
        task = ready.reduce((best, t) =>
          PRIORITY_RANK[t.priority ?? "normal"] < PRIORITY_RANK[best.priority ?? "normal"] ? t : best,
        );
      } else {
        // an unmet / missing / circular dependency — don't stall the goal
        task = pending[0];
        this.bus.emit({
          type: "log",
          level: "warn",
          text: `"${task.title}" has unmet dependencies (${(task.dependsOn ?? []).join(", ")}) — running it anyway`,
        });
      }
      pending.splice(pending.indexOf(task), 1);

      const ok = await this.runOneTask(task, goal.id, goal.text, tree);
      if (ok) finished.add(task.title.toLowerCase());
      else failures++;
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

    // 3b. reflection — every N goals, distil recent notes into durable insights
    this.goalsCompleted++;
    if (
      config.reflectEvery > 0 &&
      this.memory &&
      this.reflectChat &&
      this.goalsCompleted % config.reflectEvery === 0
    ) {
      try {
        const added = await this.memory.reflect(
          async (notes) =>
            parseLessons(await this.reflectChat!(reflectionPrompt(goal.text, formatMemories(notes)))),
          { agent: this.manager.id },
        );
        if (added.length) {
          this.bus.emit({ type: "log", level: "info", text: `reflection: recorded ${added.length} insight(s)` });
        }
      } catch (err) {
        this.bus.emit({
          type: "log",
          level: "warn",
          text: `reflection skipped: ${(err as Error).message}`,
        });
      }
    }

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
    } finally {
      goal.usage = this.summariseUsage(Date.now() - goalStart);
      this.goalUsage = null;
    }
  }
}
