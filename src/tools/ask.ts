import type { Tool } from "./index.ts";
import type { Office } from "../orchestrator/office.ts";

/**
 * Given to every worker. Calling it pauses the task while the worker "walks to
 * the manager" and gets an answer. Questions are naturally serialised — only one
 * worker runs at a time — so the office queues them for you.
 */
export function makeAskManager(office: Office): Tool {
  return {
    name: "ask_manager",
    description:
      "Ask the manager a question when you are unsure or blocked. Returns their answer. Use sparingly.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    async run(args, ctx) {
      const question = String(args.question ?? "").trim();
      if (!question) return "no question asked";
      return office.answerQuestion(ctx.agent, question);
    },
  };
}
