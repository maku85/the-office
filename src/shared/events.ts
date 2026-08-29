/**
 * The event contract between the agent engine and the office visualisation.
 *
 * The engine only ever emits these; it has no idea it is being drawn as
 * pixel-art people. The UI is free to interpret them however it likes.
 */

export type AgentId = string;

export type AgentState =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "blocked"
  | "done";

export interface AgentRegisteredEvent {
  type: "agent_registered";
  agent: AgentId;
  role: string;
  /** Where this agent sits in the office (desk id understood by the UI). */
  desk: string;
  /** Provider/model label, e.g. `ollama:qwen3:8b`. */
  model?: string;
}

export interface AgentStateEvent {
  type: "agent_state";
  agent: AgentId;
  state: AgentState;
  /** Short label of what the agent is doing right now. */
  task?: string;
  /** 0..1, when the agent chooses to self-report. */
  progress?: number;
}

export interface AgentMessageEvent {
  type: "agent_message";
  agent: AgentId;
  target?: AgentId | "all";
  text: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  agent: AgentId;
  tool: string;
  args: unknown;
  callId: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  agent: AgentId;
  tool: string;
  callId: string;
  ok: boolean;
  summary: string;
}

export interface ApprovalRequestEvent {
  type: "approval_request";
  agent: AgentId;
  requestId: string;
  action: string;
  detail: string;
}

export interface ApprovalResolvedEvent {
  type: "approval_resolved";
  requestId: string;
  approved: boolean;
}

export interface LogEvent {
  type: "log";
  agent?: AgentId;
  level: "info" | "warn" | "error";
  text: string;
}

export type TaskStatus =
  | "queued"
  | "active"
  | "reviewing"
  | "revision"
  | "done"
  | "failed";

export interface TaskUpdateEvent {
  type: "task_update";
  taskId: string;
  title: string;
  assignee: AgentId;
  status: TaskStatus;
  result?: string;
  /** low · normal · high — drives execution order within a goal */
  priority?: "low" | "normal" | "high";
  /** titles of tasks that must finish first */
  dependsOn?: string[];
}

export interface ReviewEvent {
  type: "review";
  task: string;
  by: AgentId;
  verdict: "approve" | "changes";
  feedback?: string;
}

export interface QuestionEvent {
  type: "question";
  from: AgentId;
  text: string;
}

export interface SkillUseEvent {
  type: "skill_use";
  agent: AgentId;
  skill: string;
  found: boolean;
}

export interface BoardEvent {
  type: "board";
  task: string;
  by: AgentId;
  /** post: manager pins a card · claim: worker takes it · done: worker finishes · check: manager glances */
  phase: "post" | "claim" | "done" | "check";
}

export interface AnswerEvent {
  type: "answer";
  to: AgentId;
  text: string;
}

export interface GoalUpdateEvent {
  type: "goal_update";
  goalId: string;
  text: string;
  status: TaskStatus;
  /** short merge commit, once the goal is merged into main */
  commit?: string;
  /** cumulative model usage for the goal, present on the terminal update */
  usage?: { inputTokens: number; outputTokens: number; ms: number; costUsd?: number };
}

/** One agent's model spend for a single task/turn-loop. */
export interface UsageEvent {
  type: "usage";
  agent: AgentId;
  /** provider label, e.g. `openai:gemini-2.5-flash` */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** wall-clock for the task */
  ms: number;
  /** model turns taken */
  turns: number;
}

export interface AgentDismissedEvent {
  type: "agent_dismissed";
  agent: AgentId;
}

export interface CooldownEvent {
  type: "cooldown";
  active: boolean;
  reason: string;
  /** agents that stay working (manager + the current worker) */
  keep: AgentId[];
}

export interface SystemStatsEvent {
  type: "system";
  cpu: number; // %
  cores: number;
  load: [number, number, number];
  memUsedMB: number;
  memTotalMB: number;
  procRssMB: number;
  swapUsedMB: number | null;
  swapTotalMB: number | null;
  tempC: number | null;
  models: Array<{ name: string; sizeMB: number; vramMB: number }>;
  platform: string;
  uptimeS: number;
}

/** A short gathering: the UI sends these avatars to the meeting room. */
export interface MeetingEvent {
  type: "meeting";
  participants: AgentId[];
  topic: string;
}

export type MemoryKind = "fact" | "decision" | "note" | "insight";

export interface MemoryNoteEvent {
  type: "memory_note";
  id: number;
  kind: MemoryKind;
  agent?: AgentId;
  text: string;
}

export type OfficeEvent =
  | AgentRegisteredEvent
  | AgentStateEvent
  | AgentMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | ApprovalResolvedEvent
  | LogEvent
  | TaskUpdateEvent
  | ReviewEvent
  | QuestionEvent
  | AnswerEvent
  | SkillUseEvent
  | BoardEvent
  | GoalUpdateEvent
  | UsageEvent
  | AgentDismissedEvent
  | SystemStatsEvent
  | CooldownEvent
  | MeetingEvent
  | MemoryNoteEvent;

/** Sent once when a UI client connects, so it can catch up. */
export interface SnapshotMessage {
  type: "snapshot";
  events: OfficeEvent[];
}

export type ServerMessage = OfficeEvent | SnapshotMessage;

/* ---- messages the UI sends back ---- */

export interface ApprovalDecisionMessage {
  type: "approval_decision";
  requestId: string;
  approved: boolean;
  /** approve/deny this action for the rest of the session without asking again */
  remember?: boolean;
}

export interface CommandMessage {
  type: "command";
  text: string;
}

export interface UndoGoalMessage {
  type: "undo_goal";
  goalId: string;
}

export type ClientMessage =
  | ApprovalDecisionMessage
  | CommandMessage
  | UndoGoalMessage;
