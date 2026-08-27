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

export type TaskStatus = "queued" | "active" | "done" | "failed";

export interface TaskUpdateEvent {
  type: "task_update";
  taskId: string;
  title: string;
  assignee: AgentId;
  status: TaskStatus;
  result?: string;
}

export interface GoalUpdateEvent {
  type: "goal_update";
  goalId: string;
  text: string;
  status: TaskStatus;
  /** short merge commit, once the goal is merged into main */
  commit?: string;
}

/** A short gathering: the UI sends these avatars to the meeting room. */
export interface MeetingEvent {
  type: "meeting";
  participants: AgentId[];
  topic: string;
}

export type MemoryKind = "fact" | "decision" | "note";

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
  | GoalUpdateEvent
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
