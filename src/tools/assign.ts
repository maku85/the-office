import type { Tool } from "./index.ts";
import type { Office } from "../orchestrator/office.ts";

/**
 * The manager's only tool. Each call queues one task for a worker and stages a
 * short meeting between the manager and that worker in the UI.
 */
export function makeAssignTask(office: Office): Tool {
  return {
    name: "assign_task",
    description:
      "Assign one task to a teammate by id. Call once per task. The worker only sees the 'details' text.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: `teammate id, one of: ${office.workerIds.join(", ")}` },
        title: { type: "string", description: "short task title" },
        details: {
          type: "string",
          description: "self-contained instructions for the worker",
        },
        reviewedBy: {
          type: "string",
          description:
            "optional teammate id who reviews the output before it counts as done (not the assignee)",
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "optional skill names from the skill index that apply to this task",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "execution order within the goal (default normal)",
        },
        dependsOn: {
          type: "array",
          items: { type: "string" },
          description:
            "optional exact titles of earlier tasks in this plan that must finish before this one starts",
        },
      },
      required: ["to", "title", "details"],
    },
    async run(args, ctx) {
      const to = String(args.to ?? "").trim().toLowerCase();
      if (!office.workerIds.includes(to)) {
        return `unknown teammate "${to}". Valid ids: ${office.workerIds.join(", ")}`;
      }
      const title = String(args.title ?? "task").slice(0, 120);
      const details = String(args.details ?? "").trim();
      if (!details) return "the 'details' field is required and must be self-contained";

      // keep reviewedBy even if that teammate isn't hired yet — the review step
      // resolves it at execution time (and skips if they truly don't exist).
      const rawReviewer = String(args.reviewedBy ?? "").trim().toLowerCase();
      const reviewedBy = rawReviewer && rawReviewer !== to ? rawReviewer : undefined;
      const skills = Array.isArray(args.skills)
        ? args.skills.map((s) => String(s).trim()).filter(Boolean)
        : undefined;
      const p = String(args.priority ?? "").trim().toLowerCase();
      const priority =
        p === "low" || p === "high" ? (p as "low" | "high") : undefined;
      const dependsOn = Array.isArray(args.dependsOn)
        ? args.dependsOn.map((d) => String(d).trim()).filter(Boolean)
        : undefined;

      office.enqueue({ title, details, assignee: to, reviewedBy, skills, priority, dependsOn });
      // the manager pins a card on the board; no hand-off conversation
      ctx.bus.emit({ type: "board", task: title, by: ctx.agent, phase: "post" });
      return reviewedBy
        ? `assigned "${title}" to ${to} (reviewed by ${reviewedBy})`
        : `assigned "${title}" to ${to}`;
    },
  };
}
