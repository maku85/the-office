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
  /** skills always folded into this role's brief (if present in the skills dir) */
  skills?: string[];
  /** which local model tier this role runs on (config.modelHeavy / modelLight).
   *  "heavy" for planning / code / review, "light" for spec / design / prose. */
  tier?: "heavy" | "light";
  /** tool-loop budget for this role; unset = config.maxIterations. Code roles
   *  that write → test → fix need more turns than prose roles. */
  maxTurns?: number;
  /** hand this role the `run_tests` tool (still requires OFFICE_ALLOW_SHELL). */
  canRunTests?: boolean;
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
    tier: "heavy",
  },
  analyst: {
    role: "analyst",
    blurb: "turns the goal into SPEC.md with acceptance criteria and scope",
    systemPrompt: ANALYST_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
    skills: ["write-spec"],
    tier: "light",
  },
  designer: {
    role: "designer",
    blurb: "writes DESIGN.md — screen flows / game design a developer can build from",
    systemPrompt: DESIGNER_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
    skills: ["web-ui"],
    tier: "light",
  },
  developer: {
    role: "developer",
    blurb: "builds the code from SPEC.md / DESIGN.md",
    systemPrompt: DEVELOPER_SYSTEM,
    toolset: "developer",
    writeRoots: WRITE,
    skills: ["single-file-webapp"],
    tier: "heavy",
    maxTurns: 20,
    canRunTests: true,
  },
  qa: {
    role: "QA",
    blurb: "checks the build against SPEC.md acceptance criteria; sends it back if it fails",
    systemPrompt: QA_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
    skills: ["review-checklist"],
    tier: "heavy",
    maxTurns: 18,
    canRunTests: true,
  },
  writer: {
    role: "writer",
    blurb: "writes README.md and usage docs for the finished work",
    systemPrompt: WRITER_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
    tier: "light",
  },
  researcher: {
    role: "researcher",
    blurb: "investigates a topic / library / approach and writes notes; no shell",
    systemPrompt: RESEARCHER_SYSTEM,
    toolset: "writer",
    writeRoots: WRITE,
    tier: "light",
  },
  devops: {
    role: "devops",
    blurb: "build, CI, packaging and environment setup",
    systemPrompt: DEVOPS_SYSTEM,
    toolset: "developer",
    writeRoots: WRITE,
    tier: "heavy",
    maxTurns: 18,
    canRunTests: true,
  },
};

/** Roles a manager may hire (everything except itself). */
export function hireableRoles(): string[] {
  return Object.keys(ROLES).filter((k) => k !== "manager");
}
