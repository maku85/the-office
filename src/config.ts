import path from "node:path";

/** Central configuration, all overridable via env vars. */
export const config = {
  /** HTTP + WebSocket port for the office UI. */
  port: Number(process.env.OFFICE_PORT ?? 4317),
  /** Ollama server. */
  ollamaHost: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  /** Default local brain for the workers (and the manager unless overridden). */
  model: process.env.OFFICE_MODEL ?? "qwen3:8b",
  /** Model used for memory embeddings (always local). */
  embedModel: process.env.OFFICE_EMBED_MODEL ?? "nomic-embed-text",
  /** Manager's provider: "local" (Ollama) or "openai" (any OpenAI-compatible endpoint). */
  managerProvider:
    (process.env.OFFICE_MANAGER_PROVIDER ?? "local") === "openai"
      ? ("openai" as const)
      : ("local" as const),
  /** Manager's model. Empty = same as `model`. */
  managerModel: process.env.OFFICE_MANAGER_MODEL ?? "",
  /** OpenAI-compatible endpoint used when managerProvider is "openai". */
  openaiBaseUrl: process.env.OFFICE_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  openaiApiKey: process.env.OFFICE_OPENAI_API_KEY ?? "",
  /** How many memories to pull into context per recall. */
  recallK: Number(process.env.OFFICE_RECALL_K ?? 4),
  /** Let the model emit <think> traces. Off by default: faster on 18 GB. */
  think: process.env.OFFICE_THINK === "1",
  /** Ollama `keep_alive` (e.g. "0" to unload after each call, "5m" default).
   *  Set "0" when running two big models on a small machine. */
  ollamaKeepAlive: process.env.OFFICE_OLLAMA_KEEP_ALIVE || undefined,
  /** Root of the "company" filesystem. Agents can only touch paths inside this. */
  workspace: path.resolve(process.env.OFFICE_WORKSPACE ?? path.join(process.cwd(), "workspace")),
  /** SQLite file for the persistent office memory. */
  memoryDb: path.resolve(
    process.env.OFFICE_MEMORY_DB ??
      path.join(process.env.OFFICE_WORKSPACE ?? path.join(process.cwd(), "workspace"), ".office", "memory.db"),
  ),
  /** Safety valve: max tool-loop turns per task. */
  maxIterations: Number(process.env.OFFICE_MAX_ITERS ?? 12),
  /** Give the developer the run_shell tool. Off by default: shell is not jailed. */
  allowShell: process.env.OFFICE_ALLOW_SHELL === "1",
  /** Seconds before an unanswered approval auto-denies. <= 0 disables the timeout. */
  approvalTimeout: Number(process.env.OFFICE_APPROVAL_TIMEOUT ?? 300),
  /** Attempts per LLM call (retries transient network / 5xx errors with backoff). */
  llmRetries: Math.max(1, Number(process.env.OFFICE_LLM_RETRIES ?? 3)),
  /** Version control for the workspace: "auto" (on if git is present) or "off". */
  git: (process.env.OFFICE_GIT ?? "auto") === "off" ? ("off" as const) : ("auto" as const),
  /** Keep the branch of a failed goal around for inspection. */
  keepFailedBranches: process.env.OFFICE_KEEP_FAILED_BRANCHES !== "0",
  /** Most extra agents the manager may have hired at once (analyst→designer→dev→qa→writer). */
  maxHires: Math.max(0, Number(process.env.OFFICE_MAX_HIRES ?? 5)),
  /** Start with a fixed dev + researcher, instead of just the manager. */
  seedTeam: process.env.OFFICE_SEED_TEAM === "1",
  /** Keep hired agents after their goal finishes. Default: send them home. */
  keepHires: process.env.OFFICE_KEEP_HIRES === "1",
  /** Manager does a short check-in after each task. */
  checkIns: process.env.OFFICE_CHECK_INS !== "0",
  /** How often to sample machine + Ollama state for the UI (ms). 0 disables. */
  systemPollMs: Number(process.env.OFFICE_SYSTEM_POLL_MS ?? 4000),
  /** Pause between LLM turns while the machine is overloaded. */
  loadAdapt: process.env.OFFICE_LOAD_ADAPT !== "0",
  cpuHigh: Number(process.env.OFFICE_CPU_HIGH ?? 90) / 100,
  memHigh: Number(process.env.OFFICE_MEM_HIGH ?? 96) / 100,
  loadHigh: Number(process.env.OFFICE_LOAD_HIGH ?? 1.5), // load1 / cores
  /** Resume once metrics fall below `high * this` (hysteresis). */
  cooldownResume: Number(process.env.OFFICE_COOLDOWN_RESUME ?? 0.9),
  /** Never wait longer than this for the machine to recover (ms). */
  cooldownMaxMs: Number(process.env.OFFICE_COOLDOWN_MAX_MS ?? 90_000),
  /** Max rework cycles when a task has a reviewer that keeps requesting changes. */
  maxRevisions: Math.max(0, Number(process.env.OFFICE_MAX_REVISIONS ?? 2)),
  /** MCP server config file (Claude-Desktop shape). Optional. */
  mcpConfig: path.resolve(process.env.OFFICE_MCP_CONFIG ?? path.join(process.cwd(), "mcp.config.json")),
  /** One or more folders of `<name>/SKILL.md` playbooks (`,` or `:` separated).
   *  Later folders override earlier ones on a name clash. Absent = no skills. */
  skillsDirs: (process.env.OFFICE_SKILLS_DIR ?? path.join(process.cwd(), "skills"))
    .split(/[:,]/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d)),
  /** Skip the built-in demo task on boot (used by the smoke test). */
  noAutoTask: process.env.OFFICE_NO_AUTOTASK === "1",
};
