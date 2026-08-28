import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import type { ChatMessage, Provider } from "../llm/provider.ts";
import { toToolSpecs, type Tool, type ToolContext } from "../tools/index.ts";
import type { Bus } from "../orchestrator/bus.ts";
import type { PermissionBroker } from "../orchestrator/permissions.ts";
import type { OfficeEvent } from "../shared/events.ts";

export interface AgentOptions {
  id: string;
  role: string;
  /** One line the manager sees when deciding who to assign work to. */
  blurb: string;
  desk: string;
  systemPrompt: string;
  tools: Tool[];
  provider: Provider;
  bus: Bus;
  broker: PermissionBroker;
  workspace: string;
  /** Relative dirs this agent may write to; empty means read-only. */
  writeRoots?: string[];
}

/** The slice of an agent the {@link Office} depends on (so it can be faked in tests). */
export interface AgentLike {
  id: string;
  describe(): string;
  runTask(task: string, workspace?: string): Promise<string>;
}

/**
 * One worker in the office. Owns a conversation with the model and a
 * think → act → observe loop. Emits {@link OfficeEvent}s at every step;
 * it does not know or care that those drive an animation.
 */
export class Agent implements AgentLike {
  private readonly opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.opts = opts;
  }

  get id(): string {
    return this.opts.id;
  }

  get role(): string {
    return this.opts.role;
  }

  /** `bob (developer): writes code, files, runs shell` */
  describe(): string {
    return `${this.opts.id} (${this.opts.role}): ${this.opts.blurb}`;
  }

  /** Announce this agent to any connected office UI. */
  register(): void {
    this.emit({
      type: "agent_registered",
      agent: this.opts.id,
      role: this.opts.role,
      desk: this.opts.desk,
      model: this.opts.provider.label,
    });
    this.emit({ type: "agent_state", agent: this.opts.id, state: "idle" });
  }

  private emit(event: OfficeEvent): void {
    this.opts.bus.emit(event);
  }

  /** `workspace` overrides the agent's default root (a goal worktree). */
  async runTask(task: string, workspace?: string): Promise<string> {
    const { id, bus, broker, tools } = this.opts;
    const ctx: ToolContext = {
      agent: id,
      bus,
      broker,
      workspace: workspace ?? this.opts.workspace,
      writeRoots: this.opts.writeRoots ?? [],
    };
    const toolSpec = toToolSpecs(tools);

    const messages: ChatMessage[] = [
      { role: "system", content: this.opts.systemPrompt },
      { role: "user", content: task },
    ];

    this.emit({ type: "agent_state", agent: id, state: "thinking", task });
    this.emit({ type: "log", agent: id, level: "info", text: `task: ${task}` });

    const startedAt = Date.now();
    let inTok = 0;
    let outTok = 0;
    let turnsRun = 0;
    const emitUsage = () =>
      this.emit({
        type: "usage",
        agent: id,
        model: this.opts.provider.label,
        inputTokens: inTok,
        outputTokens: outTok,
        ms: Date.now() - startedAt,
        turns: turnsRun,
      });

    let emptyReplies = 0;
    try {
    for (let turn = 0; turn < config.maxIterations; turn++) {
      turnsRun = turn + 1;
      const reply = await this.opts.provider.chat(messages, toolSpec);
      if (reply.usage) {
        inTok += reply.usage.inputTokens;
        outTok += reply.usage.outputTokens;
      }
      messages.push(reply);

      if (reply.thinking) {
        this.emit({
          type: "log",
          agent: id,
          level: "info",
          text: `thinking: ${reply.thinking.slice(0, 240)}`,
        });
      }

      const calls = reply.tool_calls ?? [];

      if (calls.length === 0) {
        const text = reply.content?.trim();
        // An empty answer with no tool call is not "done" — prod once per stall.
        if (!text && emptyReplies < 2) {
          emptyReplies++;
          messages.push({
            role: "user",
            content:
              "You returned nothing. Either call a tool to make real progress on the task, " +
              "or, only if it is genuinely finished, reply with a concrete summary of what you produced.",
          });
          continue;
        }
        const summary = text || "(no output produced)";
        this.emit({ type: "agent_message", agent: id, target: "all", text: summary });
        this.emit({ type: "agent_state", agent: id, state: "done", progress: 1 });
        this.emit({ type: "log", agent: id, level: "info", text: "task complete" });
        return summary;
      }

      for (const call of calls) {
        const callId = call.id ?? randomUUID();
        const name = call.function.name;
        const args = call.function.arguments ?? {};
        this.emit({ type: "tool_call", agent: id, tool: name, args, callId });

        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          messages.push({
            role: "tool",
            tool_name: name,
            tool_call_id: callId,
            content: `unknown tool: ${name}`,
          });
          continue;
        }

        if (tool.permission) {
          const { key, detail } = tool.permission(args);
          this.emit({ type: "agent_state", agent: id, state: "blocked", task: name });
          const verdict = await broker.check({
            agent: id,
            tool: name,
            key,
            detail,
            cwd: ctx.workspace,
          });
          if (!verdict.ok) {
            this.emit({
              type: "tool_result",
              agent: id,
              tool: name,
              callId,
              ok: false,
              summary: `blocked (${verdict.reason})`,
            });
            messages.push({
              role: "tool",
              tool_name: name,
              tool_call_id: callId,
              content: `This action was blocked (${verdict.reason}). Do not retry it; find another way.`,
            });
            continue;
          }
        }

        this.emit({ type: "agent_state", agent: id, state: "working", task: name });
        let output: string;
        let ok = true;
        try {
          output = await tool.run(args, ctx);
        } catch (err) {
          ok = false;
          output = `error: ${(err as Error).message}`;
        }
        this.emit({
          type: "tool_result",
          agent: id,
          tool: name,
          callId,
          ok,
          summary: output.slice(0, 200),
        });
        messages.push({ role: "tool", tool_name: name, tool_call_id: callId, content: output });
      }

      this.emit({ type: "agent_state", agent: id, state: "thinking", task });
    }

    this.emit({
      type: "log",
      agent: id,
      level: "warn",
      text: `hit the ${config.maxIterations}-step limit without finishing`,
    });
    this.emit({ type: "agent_state", agent: id, state: "idle" });
    throw new Error(`step limit (${config.maxIterations}) reached without completing the task`);
    } finally {
      emitUsage();
    }
  }
}
