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
  analyst: {
    role: "analyst",
    blurb: "turns the goal into SPEC.md with acceptance criteria and scope",
    systemPrompt: ANALYST_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
  },
  designer: {
    role: "designer",
    blurb: "writes DESIGN.md — screen flows / game design a developer can build from",
    systemPrompt: DESIGNER_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
  },
  developer: {
    role: "developer",
    blurb: "builds the code from SPEC.md / DESIGN.md",
    systemPrompt: DEVELOPER_SYSTEM,
    toolset: "developer",
    writeRoots: WRITE,
  },
  qa: {
    role: "QA",
    blurb: "checks the build against SPEC.md acceptance criteria; sends it back if it fails",
    systemPrompt: QA_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
  },
  writer: {
    role: "writer",
    blurb: "writes README.md and usage docs for the finished work",
    systemPrompt: WRITER_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
  },
  researcher: {
    role: "researcher",
    blurb: "investigates a topic / library / approach and writes notes; no shell",
    systemPrompt: RESEARCHER_SYSTEM,
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
