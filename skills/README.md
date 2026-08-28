# Skills

Short, versioned playbooks the office folds into an agent's brief.

## Format

`skills/<name>/SKILL.md`:

```markdown
---
name: my-skill
description: one line — shown in the skill index
roles: [developer, qa]      # optional — which roles see it in their index
keywords: [x, y]            # optional
---
The body: concrete rules + a checklist. Keep it under ~1 page / 4000 chars —
it is injected into an 8B model's prompt.
```

Unknown front-matter keys are ignored, so files written for Claude Code Agent
Skills mostly drop in — but trim them: long, prose-heavy skills degrade a small
local model, and bundled `scripts/` / `resources/` are **not** run or read here
(only the `SKILL.md` text is used).

## How a skill reaches an agent

1. **Role default** — `RoleDef.skills` in `src/agents/roles.ts` (always in the brief).
2. **Manager tag** — `assign_task({ skills: ["my-skill"] })`.
3. **On demand** — the worker calls `use_skill({ name })` (walks to the office library).

## Using an external skill folder

`OFFICE_SKILLS_DIR` takes one or more folders, `,` or `:` separated. Later
folders win on a name clash, so you can keep community skills separate:

```
OFFICE_SKILLS_DIR="./skills:/Users/me/my-skills" npm start
```
