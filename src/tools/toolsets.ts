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
  /** given to every worker: ask the manager a question mid-task */
  askManager?: Tool;
  /** given to every worker: load a skill playbook on demand */
  useSkill?: Tool;
  /** manager only */
  assignTask?: Tool;
  /** manager only: scaffold projects/<slug>/ once in planning */
  createProject?: Tool;
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
  const helpers = [
    ...(deps.reviewTool ? [deps.reviewTool] : []),
    ...(deps.askManager ? [deps.askManager] : []),
    ...(deps.useSkill ? [deps.useSkill] : []),
  ];
  switch (set) {
    case "manager":
      return [
        ...(deps.assignTask ? [deps.assignTask] : []),
        ...(deps.createProject ? [deps.createProject] : []),
        ...(deps.hireTeam ? [deps.hireTeam] : []),
        ...(deps.hireAgent ? [deps.hireAgent] : []),
        ...(deps.dismissAgent ? [deps.dismissAgent] : []),
        ...deps.memoryTools,
      ];
    case "reader":
      return [...readerFileTools, ...helpers, ...deps.memoryTools, ...deps.mcpTools];
    case "writer":
      return [...fileTools, ...helpers, ...deps.memoryTools, ...deps.mcpTools];
    case "developer":
    case "analyst":
      return [...fileTools, ...shell, ...helpers, ...deps.memoryTools, ...deps.mcpTools];
  }
}
