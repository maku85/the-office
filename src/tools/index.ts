import type { Bus } from "../orchestrator/bus.ts";
import type { PermissionBroker } from "../orchestrator/permissions.ts";
import type { ToolFunctionSpec } from "../llm/provider.ts";

export interface ToolContext {
  agent: string;
  bus: Bus;
  broker: PermissionBroker;
  /** Absolute path agents are confined to (a worktree, once milestone 4b lands). */
  workspace: string;
  /** Relative dirs this agent may write to; empty means "read-only". */
  writeRoots: string[];
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /**
   * If present, the action is routed through the permission broker before it
   * runs. `key` groups actions for "always allow"; `detail` is shown to the human.
   */
  permission?(args: Record<string, unknown>): { key: string; detail: string };
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Convert our tools into the provider-neutral function-spec shape. */
export function toToolSpecs(tools: Tool[]): ToolFunctionSpec[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
