/**
 * Deterministic sanity checks on a freshly-planned task queue — no LLM turn.
 * Returns human-readable warnings; the office logs them but never blocks on
 * them (a plan that trips a check still runs; the review loop is the backstop).
 */

export interface PlanTask {
  title: string;
  assignee: string;
  reviewedBy?: string;
  dependsOn?: string[];
}

const BUILD_GOAL = /\b(build|create|implement|make|code|develop|program|game|app|tool|script|library|website|api)\b/i;
const DEV_ID = /dev|bob/i;

export function validatePlan(
  queue: PlanTask[],
  goalText: string,
  knownAssignees: Iterable<string>,
): string[] {
  const warnings: string[] = [];
  const known = new Set(knownAssignees);
  const titles = new Set(queue.map((t) => t.title.toLowerCase()));
  const seen = new Set<string>();

  for (const t of queue) {
    if (!known.has(t.assignee)) {
      warnings.push(`task "${t.title}" is assigned to "${t.assignee}", who is not on the team`);
    }
    if (t.reviewedBy && t.reviewedBy === t.assignee) {
      warnings.push(`task "${t.title}" has reviewedBy == assignee ("${t.assignee}") — the review will be skipped`);
    }
    const key = t.title.toLowerCase();
    if (seen.has(key)) warnings.push(`duplicate task title "${t.title}"`);
    seen.add(key);

    for (const dep of t.dependsOn ?? []) {
      if (!titles.has(dep.toLowerCase())) {
        warnings.push(`task "${t.title}" dependsOn "${dep}", which is not a task in this plan`);
      }
    }
  }

  if (BUILD_GOAL.test(goalText) && queue.length > 0 && !queue.some((t) => DEV_ID.test(t.assignee))) {
    warnings.push(`the goal looks like a build, but no task went to a developer`);
  }

  return warnings;
}
