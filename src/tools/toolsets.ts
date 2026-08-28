import { config } from "../config.ts";
import type { Tool } from "./index.ts";
import { fileTools, runShell } from "./filesystem.ts";

/** Preset tool bundles a role can be given. */
export type Toolset = "reader" | "writer" | "developer" | "analyst" | "manager";

export interface ToolsetDeps {
  memoryTools: Tool[];
  mcpTools: Tool[];
  /** given to every worker; only meaningful during a review turn */
  reviewTool?: Tool;
  /** manager only */
  assignTask?: Tool;
  /** manager only */
  hireAgent?: Tool;
  /** manager only */
  hireTeam?: Tool;
  /** manager only */
  dismissAgent?: Tool;
}

const READ_ONLY = new Set(["list_files", "read_file", "report_progress"]);
const readerFileTools = fileTools.filter((t) => READ_ONLY.has(t.name));

/** Compose the concrete tool list for a preset. `run_shell` is only ever
 *  included when `OFFICE_ALLOW_SHELL=1`. */
export function toolsetFor(set: Toolset, deps: ToolsetDeps): Tool[] {
  const shell = config.allowShell ? [runShell] : [];
  const review = deps.reviewTool ? [deps.reviewTool] : [];
  switch (set) {
    case "manager":
      return [
        ...(deps.assignTask ? [deps.assignTask] : []),
        ...(deps.hireTeam ? [deps.hireTeam] : []),
        ...(deps.hireAgent ? [deps.hireAgent] : []),
        ...(deps.dismissAgent ? [deps.dismissAgent] : []),
        ...deps.memoryTools,
      ];
    case "reader":
      return [...readerFileTools, ...review, ...deps.memoryTools, ...deps.mcpTools];
    case "writer":
      return [...fileTools, ...review, ...deps.memoryTools, ...deps.mcpTools];
    case "developer":
    case "analyst":
      return [...fileTools, ...shell, ...review, ...deps.memoryTools, ...deps.mcpTools];
  }
}
