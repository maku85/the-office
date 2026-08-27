/**
 * Team templates: the extra specialists a kind of project needs on top of the
 * seed team (manager + developer + researcher). The manager calls `hire_team`
 * with the template that matches the goal.
 */
export interface TeamDef {
  description: string;
  /** role keys from ROLES to hire (specialists only — seed roles are assumed). */
  roles: string[];
}

export const TEAMS: Record<string, TeamDef> = {
  software: {
    description: "building an app, tool, script or game",
    roles: ["designer", "qa"],
  },
  game: {
    description: "building a game (alias of software)",
    roles: ["designer", "qa"],
  },
  research: {
    description: "investigating a topic and producing a written report",
    roles: ["analyst", "writer"],
  },
  data: {
    description: "analysing a dataset and writing up findings",
    roles: ["analyst", "writer"],
  },
  docs: {
    description: "writing or restructuring documentation",
    roles: ["writer"],
  },
  design: {
    description: "UX / product design direction",
    roles: ["designer", "writer"],
  },
};

export function teamNames(): string[] {
  return Object.keys(TEAMS);
}
