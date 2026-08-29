# The Office

A local, pixel-art AI office. Multiple agents work in a shared space, powered
entirely by [Ollama](https://ollama.com) — no cloud calls.

The design principle: the **agent engine** and the **office visualisation** are
fully decoupled. Agents only emit typed events (`agent_state`, `tool_call`,
`agent_message`, `approval_request`, …); the UI interprets them as little people
walking to desks, typing, talking and waiting for your approval.

## Status

An Ollama-powered office with persistent memory, a goal queue, a policy-based
permission broker and git-backed goal isolation.

**Flow**: the office starts with **only the manager** (Carol) at her desk. On a
goal she staffs up — `hire_team({template})` for a whole crew or
`hire_agent({id, role, focus})` for a one-off. Hires walk in, take a free desk,
do the work; while working they can `ask_manager({question})` if stuck (the
manager answers; questions serialise). After each task the manager does a short
check-in. When the goal is done everyone leaves and the office is back to just
Carol. `OFFICE_SEED_TEAM=1` keeps a fixed Bob+Alice instead; `OFFICE_KEEP_HIRES=1`
keeps hires around; `OFFICE_CHECK_INS=0` skips check-ins.

**Roles & pipeline** (`src/agents/roles.ts`) — consolidated, artifact-first, tuned
for one-at-a-time local execution:

| role | produces |
|------|----------|
| **analyst** | `SPEC.md` — features + acceptance criteria + scope |
| **designer** | `DESIGN.md` — screen flows / game design a dev can build from |
| **developer** | the code (builds to SPEC + DESIGN) |
| **qa** | `REVIEW.md` + the review-loop verdict, checked against the SPEC |
| **writer** | `README.md` / usage docs |
| **devops** / **researcher** | build & packaging / topic notes — hired on demand |

Pipeline: analyst → designer → developer (`reviewedBy: qa`) → writer. Templates
give the minimum crew: `software`→ dev+qa · `web` / `mobile` / `game`→ analyst +
designer + dev + qa · `docs`→ writer · `design`→ designer+writer · `research`→
researcher+writer. Hiring is capped at `OFFICE_MAX_HIRES` (5).

**Goal queue** — `Office.submitGoal()` queues goals and runs them one at a time
(`plan → execute tasks → review`); nothing is dropped when the office is busy.

**Kanban board** — assignment is a board, not a conversation. `assign_task` pins a
card (`board` event, `post`); the queue runs one worker at a time, so the assigned
worker walks up, takes the card (`claim`), does the work, and moves it to done
(`done`); the manager glances at the board on each check-in (`check`). Idle workers
just wander. The board on the bottom wall shows TO&nbsp;DO / DOING / DONE with a
card per task, striped in the assignee's colour. Tasks carry a `priority`
(`low`/`normal`/`high`) and a `dependsOn` list of earlier task titles — the goal
runs the highest-priority task whose dependencies are all `done` first (a missing
or circular dependency is run anyway, with a warning, so a goal never stalls).

**Review loop** — the manager can set `reviewedBy` on a task; after the worker
delivers, that teammate opens the files, checks against the task *and* the goal,
and calls `submit_review` (`approve` / `request_changes` with feedback). Changes
send the task back to the worker with the feedback appended, up to
`OFFICE_MAX_REVISIONS` cycles; a reviewer that errors or never responds counts as
approve.

**Smoke gate** (`orchestrator/smoke.ts`) — before that review, every `*.html` a
task just wrote is loaded in a throwaway `node:vm` DOM shim (no browser
dependency). A page whose JavaScript throws on load — syntax error, a
`ReferenceError`, `.style` on a `null` element, a missing local `<script src>`,
or a throw during `onload` / the first few timer + rAF ticks — is sent back for
rework with the concrete errors, and fails the task past `OFFICE_MAX_REVISIONS`
(so a broken page can't merge). It also warns when a keyboard game wired no key
listener. `OFFICE_SMOKE=0` disables it.

**Permission broker** (`orchestrator/permissions.ts` + `rules.ts`) — every risky
tool call is checked against ordered rules: read-only shell commands run
immediately, a hard-block list is refused outright, everything else asks a human.
Approvals can be granted for the rest of the session ("allow this…" checkbox).

**Path confinement** — write tools enforce each agent's `writeRoots`; escapes and
out-of-root paths are refused before any I/O.

**Git-backed goals** (`orchestrator/vcs.ts`) — `workspace/` is its own git repo
(separate from this project's). Each goal runs in an isolated worktree on a
`goal/<slug>` branch; tasks commit as they finish; a passing goal is `--no-ff`
merged into `main` and the worktree removed. Failed goals are abandoned (branch
kept for inspection). The Goals panel shows the merge commit and an **undo**
button (`git revert -m 1`). Absent git → the office runs unchanged on `workspace/`
directly.

**Memory** (`node:sqlite` + `nomic-embed-text`): a shared blackboard of facts,
decisions and distilled *insights* plus per-task notes, in
`workspace/.office/memory.db`. Injected into the manager's plan (insights first);
each worker gets a `recall` for its task. Survives restarts; degrades to "most
recent" if the embed model is missing.

`recall` ranks by a blend, not raw cosine:
`wᶜ·similarity + wʳ·recency + wⁱ·importance` (`OFFICE_RECALL_WEIGHTS`,
`OFFICE_MEMORY_HALFLIFE` days). `remember` takes an optional `importance` (0–1;
sensible default per kind). A new memory that is ≥ `OFFICE_MEMORY_DEDUP` Jaccard-
similar to a recent one of the same kind is *reinforced* (importance bump), not
duplicated — the table stops growing on repeats. Every `OFFICE_REFLECT_EVERY`
goals the manager distils the recent unconsolidated notes into 1–3 durable
`insight` rows and the source notes are de-weighted (`0` disables; costs one
manager call).

**Usage accounting** — every provider reports token counts (`prompt_eval_count` /
`eval_count` for Ollama, `usage` for OpenAI-compatible), which `Agent` sums per
task and emits as a `usage` event (tokens · seconds · turns). `Office` aggregates
these per goal and folds a total (and, with `OFFICE_PRICING`, a $ estimate — cloud
only) into the terminal `goal_update`. Shown in the **Usage** panel with a running
session total.

**Audit log** (`orchestrator/audit.ts`) — a curated slice of the event stream
(goal lifecycle, task done/failed, hires, reviews, approval decisions, cooldowns,
skill use, per-task usage) written append-only to `workspace/.office/audit.db`
(SQLite). Read it back as JSON at `GET /audit?kind=goal&limit=50`. Separate from
the live Activity panel (ephemeral) and the semantic memory. `OFFICE_AUDIT=0` off.

**Pixel-art office** (`public/render.js`) — a top-down pixel view, no engine.
Sprites are baked once at startup into offscreen atlases (a shared tile/furniture
atlas; one recoloured character sheet per agent with idle / 2-frame walk / sit /
type poses in three facings) and blitted with `drawImage`. Desks have monitors
that glow while their owner is `working`; avatars grid-path around the furniture,
sit at their desk while busy, wander the room and the break area when idle, walk
to the **kanban board** to take a card and to move it to done, and huddle for a
real discussion — the reviewer / manager walks over and stands beside whoever
they're talking to (a review, a worker's question), not to a fixed room.
They carry name / state / progress / speech bubbles, a pulsing badge
that stays up while they need you (`!` awaiting approval, `?` waiting on the
manager), and a ✓ / ✗ flash when a task lands. A 🔇 toggle in the panel enables
short WebAudio chimes on goal done / failed / approval-needed (off by default,
remembered in `localStorage`). The view supports **wheel-zoom (1–3.5×), drag to
pan, click an agent to follow, double-click to reset**. Walls and the
meeting-room carpet **auto-tile** — each tile picks an edge overlay from a 4-bit
N/E/S/W neighbour mask, so runs stay seamless and only exposed edges get a crown /
shadow / rug border. The room surfaces and generic furniture (floors, meeting rug,
plant, chair, table) are skinned at load from bundled
**[pixel-agents](https://github.com/pablodelucca/pixel-agents) tiles** (MIT,
`public/assets/pixel-agents/`) painted onto the baked atlas — grayscale floors /
carpet are HSL-colorized (Photoshop "Colorize"); walls, monitor desks, the water
cooler and characters stay procedural. Drop a full-atlas `public/assets/office-tiles.png` to
override the whole tileset, or delete `public/assets/pixel-agents/` for the
fully-baked look — see `public/assets/README.md`. Side panels are unchanged.

**Pluggable LLM providers** (`llm/`) — agents talk to a `Provider` interface, not
Ollama directly. `OllamaProvider` (native `/api/chat`) is the default for every
role; `OpenAIProvider` covers any OpenAI-compatible endpoint (OpenAI, OpenRouter
incl. Claude models, LM Studio, vLLM, llama.cpp). Each role carries a `tier`
(`heavy` for planning / code / review, `light` for spec / design / prose) mapped
to a local model by `OFFICE_MODEL_HEAVY` / `OFFICE_MODEL_LIGHT` — e.g. `qwen3:14b`
+ `qwen3:4b` on an 18 GB box, both staying resident so no reload between roles.
`OFFICE_MODEL_<ROLE>` overrides one role. Any of these can name a `cloud:` model
(`OFFICE_MODEL_DEVELOPER=cloud:gpt-4o-mini`) to route just that role through the
OpenAI-compatible endpoint (`OFFICE_OPENAI_BASE_URL` + `OFFICE_OPENAI_API_KEY`)
while the rest stay local; `OFFICE_MANAGER_PROVIDER=openai` is the older
manager-only switch. Providers are cached per model string, so roles on the same
model share one. Unset = every role on `OFFICE_MODEL`. Embeddings stay local.

**MCP tools** (`mcp/`) — a minimal stdio Model Context Protocol client. Drop an
`mcp.config.json` (the Claude-Desktop `{ "mcpServers": { … } }` shape) and the
workers gain every tool those servers expose (web fetch, real GitHub, a database,
a bigger filesystem…), namespaced `server__tool`. Servers marked `"trust":
"allow"` run without prompting; otherwise each call goes through the permission
broker. A missing config is fine; a server that won't start is logged and
skipped. See `mcp.config.example.json`.

**Skills** (`skills/<name>/SKILL.md`, `src/skills/`) — short, versioned playbooks
for recurring situations: `canvas-game`, `single-file-webapp`, `web-ui`,
`write-spec`, `review-checklist`, `debug-methodically`, `git-hygiene`,
`mobile-app`. Three ways they reach an agent: baked into a role's brief
(`RoleDef.skills`), tagged on a task by the manager (`assign_task({skills:[…]})`),
or pulled on demand by the worker via `use_skill` — which walks the avatar to the
office **library**, shows the title, then back to the desk. `OFFICE_SKILLS_DIR`
takes one or more folders (`,`/`:` separated; later wins on a name clash), so a
curated community-skills folder can sit alongside the bundled ones. Absent =
feature off. Format matches Claude Code Agent Skills — trim long ones, and note
bundled `scripts/` aren't run here. See `skills/README.md`.

**Tests** (`node:test`, no LLM) — cover the deterministic core: permission
broker + rules, path confinement, memory (cosine recall, fallback, persistence),
the git worktree lifecycle (incl. the "nested repo" regression), the goal queue,
the OpenAI provider's translation, and the MCP client (against a fake stdio
server), the approval timeout, LLM retry, the failed-task-fails-goal path, the
role toolsets, dynamic hire/dismiss, and the review loop (changes→rework→approve,
capped). `npm test` — 70 checks, ~1s. Multi-goal
runs against real Ollama (incl. the manager hiring a designer + QA mid-goal)
(plan → hand-off → per-task commit → merge → cross-goal recall) has been
exercised end to end.

## Safety / isolation

- **File tools** (`read/write/append/list_files`) are hard-confined to
  `workspace/` — including against a symlinked parent directory (`realpath`
  check). Writes are further limited to each agent's `writeRoots`
  (`projects/`, `shared/`); the manager cannot write at all.
- **git** stays inside `workspace/`'s own repo — separate from this project's.
- **`run_shell` is opt-in** (`OFFICE_ALLOW_SHELL=1`) and, when on, is only
  `cwd`-scoped, not jailed. Destructive patterns (`rm -rf`, `sudo`, `curl … | sh`)
  are hard-blocked. No-path commands (`pwd`, `git status`, `npm test`, …) auto-run.
  File readers (`cat`, `grep`, `ls`, …) auto-run **only if every path argument
  resolves inside the workspace and there are no shell metacharacters**;
  anything else — including `find` — needs human approval, which **auto-denies
  after `OFFICE_APPROVAL_TIMEOUT` seconds** if unanswered.
- No outbound network unless you add an MCP fetch server.

**Resilience**: a failed task (or an LLM step-limit) fails its goal — the branch
is kept, not merged; an empty plan fails the goal. LLM calls retry transient
network / 5xx errors with backoff (`OFFICE_LLM_RETRIES`).

**Machine monitor** (`orchestrator/system.ts`) — a small overlay on the office
shows CPU, RAM (from `vm_stat`), swap (`sysctl vm.swapusage`), load average, this
process's RSS, and — from Ollama's `/api/ps` — which models are resident and how
big they are. Handy on a small box running two local models. Temperature needs a
helper (`osx-cpu-temp`); Apple Silicon needs `sudo powermetrics`, so it usually
shows as unavailable.

**Load-adaptive pacing** — before each worker / review LLM turn, if the machine
is over `OFFICE_CPU_HIGH` / `OFFICE_MEM_HIGH` / `OFFICE_LOAD_HIGH` the office
pauses (`cooldown` event → the idle workers head to the break room; the current
worker and the manager stay). It resumes once the metrics fall back below those
thresholds × `OFFICE_COOLDOWN_RESUME`, or after `OFFICE_COOLDOWN_MAX_MS` no
matter what — so the flow can never wedge. `OFFICE_LOAD_ADAPT=0` disables it.


## Requirements

- Node.js ≥ 22.9 (runs the TypeScript directly, no build step; `.env` auto-loaded)
- Ollama running locally with:
  ```
  ollama pull qwen3:8b          # shared brain (native tool-calling)
  ollama pull nomic-embed-text  # for memory, milestone 3
  ```

## Run

```
npm install
cp .env.example .env   # optional — set models / ports / flags here
npm start              # → http://localhost:4317
npm test               # deterministic unit tests, no Ollama needed
npm run typecheck
```

`npm start` / `npm run dev` load `.env` if present (`KEY=value` per line). You can
also pass vars inline (`OFFICE_MODEL_HEAVY=qwen3:14b npm start`) or `export` them.

Open <http://localhost:4317>. The office starts idle — just the manager at their
desk. Type in the command box to give it a goal (or set `OFFICE_AUTOTASK=1` for a
built-in demo goal on boot).

## Configuration (env vars)

| var | default | meaning |
|-----|---------|---------|
| `OFFICE_PORT` | `4317` | UI port |
| `OFFICE_MODEL` | `qwen3:8b` | local model for any role without a tier / override |
| `OFFICE_MODEL_HEAVY` / `_LIGHT` | *(= `OFFICE_MODEL`)* | model per role tier — heavy = manager/developer/qa/devops, light = analyst/designer/writer/researcher |
| `OFFICE_MODEL_<ROLE>` | — | pin one role, e.g. `OFFICE_MODEL_DEVELOPER=qwen3:14b`, or `cloud:<model>` for that role via the OpenAI endpoint |
| `OFFICE_EMBED_MODEL` | `nomic-embed-text` | model for memory embeddings (always local) |
| `OFFICE_MANAGER_PROVIDER` | `local` | `openai` to run the manager on an OpenAI-compatible endpoint |
| `OFFICE_MANAGER_MODEL` | *(= heavy tier)* | manager's model (local name, or the cloud model id) |
| `OFFICE_OPENAI_BASE_URL` | `https://api.openai.com/v1` | used when manager provider is `openai` |
| `OFFICE_OPENAI_API_KEY` | — | required when manager provider is `openai` |
| `OFFICE_THINK` | `0` | `1` to keep model thinking traces |
| `OFFICE_WORKSPACE` | `./workspace` | the "company" filesystem; agents are confined here |
| `OFFICE_MEMORY_DB` | `<workspace>/.office/memory.db` | SQLite memory file |
| `OFFICE_AUDIT` / `OFFICE_AUDIT_DB` | `1` / `<workspace>/.office/audit.db` | append-only audit log of state changes (`0` disables); read via `GET /audit` |
| `OFFICE_RECALL_K` | `4` | memories pulled into context per recall |
| `OFFICE_RECALL_WEIGHTS` | `0.6,0.2,0.2` | recall score weights: similarity, recency, importance |
| `OFFICE_MEMORY_HALFLIFE` | `14` | days for the recall recency weight to decay to e⁻¹ |
| `OFFICE_MEMORY_DEDUP` | `0.6` | Jaccard threshold to reinforce vs. store a new memory (`0` disables) |
| `OFFICE_REFLECT_EVERY` | `5` | distil notes into `insight` memories every N goals (`0` disables) |
| `OFFICE_MAX_ITERS` | `12` | max tool-loop turns per task |
| `OFFICE_ALLOW_SHELL` | `0` | `1` to give the developer `run_shell` (see Safety) |
| `OFFICE_APPROVAL_TIMEOUT` | `300` | seconds before an unanswered approval auto-denies (`0` = never) |
| `OFFICE_LLM_RETRIES` | `3` | attempts per LLM call on transient 5xx / network errors |
| `OFFICE_RATE_LIMIT_MAX_WAIT_MS` | `120000` | on an API 429, wait the server's hinted delay and continue, up to this total per call (`0` = fail fast) |
| `OFFICE_PRICING` | — | path to a JSON `{ "model-id": { "in": 3.0, "out": 15.0 } }` ($/1M tokens) — adds a $ column to the Usage panel; local models cost 0 |
| `OFFICE_SEED_TEAM` | `0` | `1` to start with a fixed Bob + Alice, not just the manager |
| `OFFICE_AUTOTASK` | `0` | `1` to submit a built-in demo goal ~1.5s after boot (default: start idle) |
| `OFFICE_MAX_HIRES` | `5` | most specialists the manager may hire at once |
| `OFFICE_KEEP_HIRES` | `0` | `1` to keep hires after their goal (default: they leave) |
| `OFFICE_CHECK_INS` | `1` | `0` to skip the manager's per-task check-in |
| `OFFICE_MAX_REVISIONS` | `2` | max rework cycles a reviewer / the smoke gate can trigger |
| `OFFICE_SMOKE` | `1` | `0` to skip loading produced HTML in a headless shim before review |
| `OFFICE_SYSTEM_POLL_MS` | `4000` | machine-stats sample interval; `0` disables the monitor |
| `OFFICE_LOAD_ADAPT` | `1` | `0` to disable pausing between turns under load |
| `OFFICE_CPU_HIGH` / `OFFICE_MEM_HIGH` | `90` / `96` | % thresholds that trigger a cooldown |
| `OFFICE_LOAD_HIGH` | `1.5` | load1 ÷ cores threshold |
| `OFFICE_COOLDOWN_RESUME` | `0.9` | resume once metrics drop below `high × this` |
| `OFFICE_COOLDOWN_MAX_MS` | `90000` | hard cap on a single cooldown wait |
| `OFFICE_OLLAMA_KEEP_ALIVE` | *(Ollama default)* | e.g. `0` to unload each model after use (two big models on a small box) |
| `OFFICE_GIT` | `auto` | `off` to disable the workspace git repo / worktrees |
| `OFFICE_KEEP_FAILED_BRANCHES` | `1` | `0` to delete the branch of a failed goal |
| `OFFICE_MCP_CONFIG` | `./mcp.config.json` | MCP server config file (optional) |
| `OFFICE_SKILLS_DIR` | `./skills` | folder(s) of `<name>/SKILL.md` playbooks, `,`/`:` separated (optional) |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server |

## Layout

```
src/
  config.ts               env-driven config
  shared/events.ts        the engine ⇄ UI event contract
  llm/provider.ts         provider-neutral chat interface + message shapes
  llm/ollama.ts           OllamaProvider (native /api/chat) + embeddings
  llm/openai.ts           OpenAIProvider (any OpenAI-compatible endpoint)
  llm/index.ts            buildProviders(): which model each role uses
  mcp/client.ts           minimal stdio JSON-RPC MCP client
  mcp/tools.ts            bridge MCP tools -> office Tool
  mcp/index.ts            loadMcpServers(): read config, start, bridge
  tools/filesystem.ts        list/read/write/append (writeRoots) + run_shell
  tools/assign.ts            the manager's assign_task tool (pins a kanban card)
  tools/hiring.ts            hire_agent / hire_team / dismiss_agent tools
  tools/review.ts            submit_review tool (used during a review turn)
  tools/ask.ts               ask_manager tool (worker → manager question)
  tools/skill.ts             use_skill tool (loads a playbook)
  skills/index.ts            SKILL.md registry (front-matter + on-demand bodies)
  tools/memory.ts            remember / recall tools
  tools/toolsets.ts          role -> concrete tool bundle
  agents/agent.ts            the think/act/observe loop
  agents/roles.ts            the role catalogue (prompt + toolset + writeRoots)
  agents/teams.ts            project-type team templates for hire_team
  agents/prompts.ts          system + per-turn prompts
  orchestrator/bus.ts        event bus
  orchestrator/permissions.ts policy-based approval broker
  orchestrator/rules.ts      default shell rules + hard-block list
  orchestrator/office.ts     goal queue → plan → execute → review → merge
  orchestrator/memory.ts     SQLite blackboard, weighted recall, dedup, reflection
  orchestrator/vcs.ts        workspace git repo + per-goal worktrees
  orchestrator/smoke.ts      headless "does the page load" check (no browser dep)
  orchestrator/system.ts     machine + Ollama stats sampler
  server.ts               static UI + WebSocket bridge
  main.ts                 wiring
public/render.js          procedural pixel-art office renderer
public/app.js             event-stream client + side panels
public/assets/pixel-agents/ bundled environment tiles (MIT, from pixel-agents)
test/                     node:test suites (no LLM)
```

## Credits

Environment tiles are skinned from **[pixel-agents](https://github.com/pablodelucca/pixel-agents)**
by Pablo De Lucca — [MIT License](https://github.com/pablodelucca/pixel-agents/blob/main/LICENSE).
The PNGs in `public/assets/pixel-agents/` are renamed but otherwise unmodified;
see that folder's `LICENSE` and `CREDITS.md`. (pixel-agents' own character
sprites derive from JIK-A-4's CC0 "MetroCity" pack; we bundle only tiles.)
