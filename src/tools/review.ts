import type { Tool } from "./index.ts";
import type { Office } from "../orchestrator/office.ts";

/**
 * Given to every worker. When an agent is running a review turn (see
 * `Office.runReview`), calling this records their verdict for the office to act
 * on. Outside a review turn it is a harmless no-op the model shouldn't reach.
 */
export function makeReviewTool(office: Office): Tool {
  return {
    name: "submit_review",
    description:
      "Record your verdict on the work you were asked to review. Call exactly once.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["approve", "request_changes"] },
        feedback: {
          type: "string",
          description:
            "blocking problems, required for request_changes — a numbered list, " +
            "one line each: '1. <what is wrong> — <where: file / function>'. " +
            "No source code, no fix instructions.",
        },
        suggestions: {
          type: "string",
          description: "optional non-blocking nice-to-haves; recorded, never sent back for rework",
        },
      },
      required: ["verdict"],
    },
    async run(args) {
      const changes = args.verdict === "request_changes";
      const feedback = typeof args.feedback === "string" ? args.feedback.trim() : "";
      const suggestions = typeof args.suggestions === "string" ? args.suggestions.trim() : "";
      office.recordReview(changes ? "changes" : "approve", feedback || undefined, suggestions || undefined);
      return changes ? "recorded: changes requested" : "recorded: approved";
    },
  };
}
