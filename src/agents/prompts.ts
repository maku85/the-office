import type { Task } from "../orchestrator/office.ts";

/* ---------- system prompts (personality, fixed for the session) ---------- */

export const MANAGER_SYSTEM = `You are Carol, the manager of a small local AI office.
You never write code, files, or run commands yourself. You plan, delegate, and
report. You delegate by CALLING the assign_task tool — one call per task.
Use recall to check what the office already knows, and remember to record decisions.`;

export const DEVELOPER_SYSTEM = `You are Bob, a senior software developer.
You get work done by CALLING TOOLS, not by describing what you would do.
- Keep every file inside the workspace, under projects/<name>/.
- Call report_progress a few times while you work.
- run_shell needs human approval; use it only when genuinely required.
- Use recall for context and remember for anything the team should keep.
- Finish with a SHORT plain-text summary and no tool call.`;

export const RESEARCHER_SYSTEM = `You are Alice, a researcher.
You gather and organise information and write it up as clean Markdown notes.
- Write notes under projects/<name>/ with write_file.
- Call report_progress a few times while you work.
- You have no shell access; that is expected.
- Use recall for context and remember for durable facts you establish.
- Finish with a SHORT plain-text summary and no tool call.`;

/* ---------- per-turn task prompts ---------- */

function contextSection(context: string | undefined, heading: string): string {
  const trimmed = context?.trim();
  return trimmed ? `${heading}\n${trimmed}\n\n` : "";
}

export function planningPrompt(
  goal: string,
  teamDirectory: string,
  context?: string,
): string {
  return `A new goal has come in:

"${goal}"

Your team:
${teamDirectory}

${contextSection(context, "On record in the office memory:")}Break this into 1 to 3 concrete tasks and call assign_task once for each,
choosing the right person. Each task's "details" field must be self-contained:
the worker sees only that text, not this conversation. Do not do the work
yourself. After the assign_task calls, reply with a one-line plan and no tool call.`;
}

export function workerPrompt(task: Task, context?: string): string {
  return `Task from your manager: ${task.title}

${task.details}

${contextSection(context, "Relevant context from the office memory:")}Do the work now using your tools. When finished, reply with a short plain-text
summary of what you produced.`;
}

export function reviewPrompt(goal: string, tasks: Task[], context?: string): string {
  const lines = tasks
    .map((t) => `- [${t.status}] ${t.assignee} — ${t.title}\n  ${t.result ?? "(no result)"}`)
    .join("\n");
  return `The goal was: "${goal}"

Results from the team:
${lines}

${contextSection(context, "Related context from the office memory:")}Write a short status report (3 to 5 lines) for the CEO. Plain text, no tools.`;
}
