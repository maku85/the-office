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

**Seed team**: Carol (manager, read-only, delegates via `assign_task`), Bob
(developer), Alice (researcher). **Role catalogue** (`src/agents/roles.ts`):
manager · developer · researcher · qa · designer · analyst · writer · devops,
each with a system prompt, a tool preset (`src/tools/toolsets.ts`) and
`writeRoots`. **Dynamic hiring**: the manager calls `hire_agent({id, role, focus})`
to bring a specialist onto the team mid-goal (they get a free desk, appear in the
UI); `dismiss_agent` or auto-dismiss (`OFFICE_KEEP_HIRES=0`) sends them home.
Capped at `OFFICE_MAX_HIRES`. **Team templates** (`src/agents/teams.ts`):
`hire_team({template})` staffs a whole crew at once — `software` / `game`
(→ designer + qa), `research` / `data` (→ analyst + writer), `docs`, `design` —
which the manager picks based on the goal.

**Goal queue** — `Office.submitGoal()` queues goals and runs them one at a time
(`plan → execute tasks → review`); nothing is dropped when the office is busy.

**Review loop** — the manager can set `reviewedBy` on a task; after the worker
delivers, that teammate opens the files, checks against the task *and* the goal,
and calls `submit_review` (`approve` / `request_changes` with feedback). Changes
send the task back to the worker with the feedback appended, up to
`OFFICE_MAX_REVISIONS` cycles; a reviewer that errors or never responds counts as
approve.

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

**Memory** (`node:sqlite` + `nomic-embed-text`): a shared blackboard of facts and
decisions plus per-task notes, in `workspace/.office/memory.db`. Injected into the
manager's plan; each worker gets an embedding `recall` for its task. Survives
restarts; degrades to "most recent" if the embed model is missing.

**Pixel-art office** (`public/render.js`) — a top-down pixel view, no engine.
Sprites are baked once at startup into offscreen atlases (a shared tile/furniture
atlas; one recoloured character sheet per agent with idle / 2-frame walk / sit /
type poses in three facings) and blitted with `drawImage`. Desks have monitors
that glow while their owner is `working`; avatars grid-path around the furniture,
sit at their desk, gather in the meeting room on hand-offs, and carry name /
state / progress / speech bubbles. Drop `public/assets/office-tiles.png` (same
16px cell layout as the baked atlas) to override the tiles with real art. Side
panels are unchanged.

**Pluggable LLM providers** (`llm/`) — agents talk to a `Provider` interface, not
Ollama directly. `OllamaProvider` (native `/api/chat`) is the default for every
role; `OpenAIProvider` covers any OpenAI-compatible endpoint (OpenAI, OpenRouter
incl. Claude models, LM Studio, vLLM, llama.cpp). The manager can be pointed at a
different local model or a cloud one while the workers stay local — set
`OFFICE_MANAGER_PROVIDER` / `OFFICE_MANAGER_MODEL`. Embeddings stay local.

**MCP tools** (`mcp/`) — a minimal stdio Model Context Protocol client. Drop an
`mcp.config.json` (the Claude-Desktop `{ "mcpServers": { … } }` shape) and the
workers gain every tool those servers expose (web fetch, real GitHub, a database,
a bigger filesystem…), namespaced `server__tool`. Servers marked `"trust":
"allow"` run without prompting; otherwise each call goes through the permission
broker. A missing config is fine; a server that won't start is logged and
skipped. See `mcp.config.example.json`.

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


## Requirements

- Node.js ≥ 22.6 (runs the TypeScript directly, no build step)
- Ollama running locally with:
  ```
  ollama pull qwen3:8b          # shared brain (native tool-calling)
  ollama pull nomic-embed-text  # for memory, milestone 3
  ```

## Run

```
npm install
npm start      # → http://localhost:4317
npm test       # deterministic unit tests, no Ollama needed
npm run typecheck
```

Open <http://localhost:4317>. On boot the office is given a demo goal; type in
the command box to give it new goals.

## Configuration (env vars)

| var | default | meaning |
|-----|---------|---------|
| `OFFICE_PORT` | `4317` | UI port |
| `OFFICE_MODEL` | `qwen3:8b` | local Ollama model for the workers |
| `OFFICE_EMBED_MODEL` | `nomic-embed-text` | model for memory embeddings (always local) |
| `OFFICE_MANAGER_PROVIDER` | `local` | `openai` to run the manager on an OpenAI-compatible endpoint |
| `OFFICE_MANAGER_MODEL` | *(= `OFFICE_MODEL`)* | manager's model (local model name, or the cloud model id) |
| `OFFICE_OPENAI_BASE_URL` | `https://api.openai.com/v1` | used when manager provider is `openai` |
| `OFFICE_OPENAI_API_KEY` | — | required when manager provider is `openai` |
| `OFFICE_THINK` | `0` | `1` to keep model thinking traces |
| `OFFICE_WORKSPACE` | `./workspace` | the "company" filesystem; agents are confined here |
| `OFFICE_MEMORY_DB` | `<workspace>/.office/memory.db` | SQLite memory file |
| `OFFICE_RECALL_K` | `4` | memories pulled into context per recall |
| `OFFICE_MAX_ITERS` | `12` | max tool-loop turns per task |
| `OFFICE_ALLOW_SHELL` | `0` | `1` to give the developer `run_shell` (see Safety) |
| `OFFICE_APPROVAL_TIMEOUT` | `300` | seconds before an unanswered approval auto-denies (`0` = never) |
| `OFFICE_LLM_RETRIES` | `3` | attempts per LLM call on transient errors |
| `OFFICE_MAX_HIRES` | `4` | most specialists the manager may hire at once |
| `OFFICE_KEEP_HIRES` | `1` | `0` to auto-dismiss hires when their goal finishes |
| `OFFICE_MAX_REVISIONS` | `2` | max rework cycles a reviewer can trigger on a task |
| `OFFICE_OLLAMA_KEEP_ALIVE` | *(Ollama default)* | e.g. `0` to unload each model after use (two big models on a small box) |
| `OFFICE_GIT` | `auto` | `off` to disable the workspace git repo / worktrees |
| `OFFICE_KEEP_FAILED_BRANCHES` | `1` | `0` to delete the branch of a failed goal |
| `OFFICE_MCP_CONFIG` | `./mcp.config.json` | MCP server config file (optional) |
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
  tools/assign.ts            the manager's assign_task tool
  tools/hiring.ts            hire_agent / hire_team / dismiss_agent tools
  tools/review.ts            submit_review tool (used during a review turn)
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
  orchestrator/memory.ts     SQLite blackboard + embedding recall
  orchestrator/vcs.ts        workspace git repo + per-goal worktrees
  server.ts               static UI + WebSocket bridge
  main.ts                 wiring
public/render.js          procedural pixel-art office renderer
public/app.js             event-stream client + side panels
test/                     node:test suites (no LLM)
```
