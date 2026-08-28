import type { Tool } from "./index.ts";
import type { SkillRegistry } from "../skills/index.ts";

/** Lets a worker pull a skill's full instructions on demand. */
export function makeUseSkill(skills: SkillRegistry): Tool {
  return {
    name: "use_skill",
    description:
      "Load a skill's full instructions when your task matches one in the skill index. Call before you start.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    async run(args, ctx) {
      const wanted = String(args.name ?? "").trim();
      const skill = skills.get(wanted);
      ctx.bus.emit({
        type: "skill_use",
        agent: ctx.agent,
        skill: skill?.name ?? wanted ?? "?",
        found: !!skill,
      });
      if (!skill) {
        const list = skills.all.map((s) => s.name).join(", ") || "(none)";
        return `no skill named "${wanted}". Available: ${list}`;
      }
      return `# Skill: ${skill.name}\n${skill.body}`.slice(0, 6000);
    },
  };
}
