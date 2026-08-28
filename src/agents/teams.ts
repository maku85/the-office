/**
 * Team templates: the crew the manager hires for a kind of project. The office
 * now starts with only the manager, so these include the developer too.
 * Pipeline: analyst (SPEC) → designer (DESIGN) → developer (build) → qa (review)
 * → writer (docs). Templates list the minimum; the manager adds as needed.
 */
export interface TeamDef {
  description: string;
  roles: string[];
}

export const TEAMS: Record<string, TeamDef> = {
  software: {
    description: "an app, tool, script or library (no UI design surface)",
    roles: ["developer", "qa"],
  },
  web: {
    description: "a website or web app (UI + code)",
    roles: ["analyst", "designer", "developer", "qa"],
  },
  mobile: {
    description: "a mobile app",
    roles: ["analyst", "designer", "developer", "qa"],
  },
  game: {
    description: "a video game",
    roles: ["analyst", "designer", "developer", "qa"],
  },
  docs: {
    description: "documentation for existing work",
    roles: ["writer"],
  },
  design: {
    description: "a UX / UI / game-design deliverable, no code",
    roles: ["designer", "writer"],
  },
  research: {
    description: "investigate a topic and write it up",
    roles: ["researcher", "writer"],
  },
};

export function teamNames(): string[] {
  return Object.keys(TEAMS);
}
