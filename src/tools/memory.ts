import type { Tool } from "./index.ts";
import { type Memory, formatMemories } from "../orchestrator/memory.ts";
import { config } from "../config.ts";

/** Tools that let any agent read from and write to the shared office memory. */
export function makeMemoryTools(memory: Memory): Tool[] {
  const remember: Tool = {
    name: "remember",
    description:
      "Save something to the shared office memory so the team keeps it across tasks. " +
      "Use kind 'decision' for choices made, 'fact' for durable facts, 'note' otherwise.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        kind: { type: "string", enum: ["fact", "decision", "note"] },
        importance: {
          type: "number",
          description:
            "0..1, optional — how strongly this should outrank other memories on recall.",
        },
      },
      required: ["text"],
    },
    async run(args, ctx) {
      const kind = args.kind === "fact" || args.kind === "decision" ? args.kind : "note";
      const text = String(args.text ?? "").trim();
      if (!text) return "nothing to remember";
      const importance = typeof args.importance === "number" ? args.importance : undefined;
      await memory.remember({ kind, agent: ctx.agent, text, importance });
      return `remembered (${kind})`;
    },
  };

  const recall: Tool = {
    name: "recall",
    description: "Search the shared office memory for context relevant to a query.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async run(args) {
      const rows = await memory.recall(String(args.query ?? ""), config.recallK);
      return rows.length ? formatMemories(rows) : "(nothing on record)";
    },
  };

  return [remember, recall];
}
