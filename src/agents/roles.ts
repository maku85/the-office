import type { Toolset } from "../tools/toolsets.ts";
import {
  MANAGER_SYSTEM,
  DEVELOPER_SYSTEM,
  RESEARCHER_SYSTEM,
  QA_SYSTEM,
  DESIGNER_SYSTEM,
  ANALYST_SYSTEM,
  WRITER_SYSTEM,
  DEVOPS_SYSTEM,
} from "./prompts.ts";

export interface RoleDef {
  /** display label shown in the office */
  role: string;
  /** one line the manager sees when deciding who to assign / hire */
  blurb: string;
  systemPrompt: string;
  toolset: Toolset;
  writeRoots: string[];
}

const WRITE = ["projects/", "shared/"];

/** The catalogue `main.ts` and the `hire_agent` tool build agents from. */
export const ROLES: Record<string, RoleDef> = {
  manager: {
    role: "manager",
    blurb: "plans and delegates; does no hands-on work",
    systemPrompt: MANAGER_SYSTEM,
    toolset: "manager",
    writeRoots: [],
  },
  developer: {
    role: "developer",
    blurb: "writes code and files",
    systemPrompt: DEVELOPER_SYSTEM,
    toolset: "developer",
    writeRoots: WRITE,
  },
  researcher: {
    role: "researcher",
    blurb: "gathers information and writes Markdown notes; no shell access",
    systemPrompt: RESEARCHER_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
  },
  qa: {
    role: "QA",
    blurb: "reviews work against acceptance criteria and writes review notes",
    systemPrompt: QA_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
  },
  designer: {
    role: "designer",
    blurb: "UX/UI direction, user flows and wireframe descriptions",
    systemPrompt: DESIGNER_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
  },
  analyst: {
    role: "analyst",
    blurb: "data analysis; Python/CSV when shell is enabled",
    systemPrompt: ANALYST_SYSTEM,
    toolset: "analyst",
    writeRoots: WRITE,
  },
  writer: {
    role: "writer",
    blurb: "clear documentation and prose",
    systemPrompt: WRITER_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
  },
  devops: {
    role: "devops",
    blurb: "build, CI, packaging and environment setup",
    systemPrompt: DEVOPS_SYSTEM,
    toolset: "developer",
    writeRoots: WRITE,
  },
};

/** Roles a manager may hire (everything except itself). */
export function hireableRoles(): string[] {
  return Object.keys(ROLES).filter((k) => k !== "manager");
}
