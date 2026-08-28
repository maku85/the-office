---
name: write-spec
description: How to write SPEC.md so QA can actually verify it
roles: [analyst]
keywords: [spec, requirements, acceptance criteria, scope, po]
---
# Writing SPEC.md

Keep it under ~40 lines. No implementation or visual-design detail — that is the
designer's and developer's job.

## Structure
1. **Goal** — one line: what, and for whom.
2. **Features** — a short bullet list; each a single user-visible capability.
3. **Acceptance criteria** — NUMBERED. Each is one checkable statement, ideally
   "When X, the system does Y." QA ticks these off. Ban vague words: fast, nice,
   robust, intuitive, modern.
4. **Constraints** — tech, size ("one file"), platform, performance budget, and
   anything that must NOT change.
5. **Out of scope** — an explicit list of what this goal does not cover.

## Rules
- If the goal is ambiguous, write down the assumption you made rather than
  leaving it open.
- Every feature must have at least one acceptance criterion.
- Prefer 5–10 sharp criteria over 20 loose ones.

## Example criterion
> 3. When the player presses R after "Game Over", the board, score and snake
>    reset to their initial state and play resumes.
