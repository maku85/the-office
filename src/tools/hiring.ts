import type { Tool } from "./index.ts";
import type { Office } from "../orchestrator/office.ts";
import { hireableRoles } from "../agents/roles.ts";
import { TEAMS, teamNames } from "../agents/teams.ts";

/** Lets the manager bring a specialist onto the team mid-goal. */
export function makeHireAgent(office: Office): Tool {
  return {
    name: "hire_agent",
    description:
      "Bring a specialist onto the team when the current members lack the skill. " +
      "Call this before assigning them work.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "short unique name, e.g. 'dana'" },
        role: { type: "string", description: `one of: ${hireableRoles().join(", ")}` },
        focus: {
          type: "string",
          description: "optional one-line brief for this specific hire",
        },
      },
      required: ["id", "role"],
    },
    async run(args) {
      const role = String(args.role ?? "")
        .trim()
        .toLowerCase();
      if (!hireableRoles().includes(role)) {
        return `unknown role "${role}". Valid roles: ${hireableRoles().join(", ")}`;
      }
      const focus = typeof args.focus === "string" ? args.focus.trim() : undefined;
      try {
        const agent = office.hire(String(args.id ?? ""), role, focus || undefined);
        return `hired ${agent.id} as ${role}`;
      } catch (err) {
        return `could not hire: ${(err as Error).message}`;
      }
    },
  };
}

/** Staffs up a whole project team in one call. */
export function makeHireTeam(office: Office): Tool {
  return {
    name: "hire_team",
    description:
      "Bring in a project team in one call. Use this first for a build or creative goal, " +
      "then assign work. Adds the specialists your seed team lacks.",
    parameters: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description: `one of: ${teamNames()
            .map((n) => `${n} (${TEAMS[n].description})`)
            .join("; ")}`,
        },
      },
      required: ["template"],
    },
    async run(args) {
      const key = String(args.template ?? "")
        .trim()
        .toLowerCase();
      const team = TEAMS[key];
      if (!team) return `unknown template "${key}". Valid: ${teamNames().join(", ")}`;

      const results: string[] = [];
      for (const role of team.roles) {
        try {
          const agent = office.hire(role, role);
          results.push(`hired ${agent.id} (${role})`);
        } catch (err) {
          results.push(`skipped ${role}: ${(err as Error).message}`);
        }
      }
      return `team "${key}": ${results.join("; ")}`;
    },
  };
}

/** Lets the manager send a hired specialist home. */
export function makeDismissAgent(office: Office): Tool {
  return {
    name: "dismiss_agent",
    description: "Send a previously hired specialist home. Seed team members cannot be dismissed.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async run(args) {
      try {
        office.dismiss(
          String(args.id ?? "")
            .trim()
            .toLowerCase(),
        );
        return `dismissed ${args.id}`;
      } catch (err) {
        return `could not dismiss: ${(err as Error).message}`;
      }
    },
  };
}
