import { config } from "../config.ts";
import { OllamaProvider } from "./ollama.ts";
import { CloudProvider } from "./cloud.ts";
import { FailoverProvider } from "./failover.ts";
import type { ChatMessage, Provider, ToolFunctionSpec } from "./provider.ts";

export type { Provider, ChatMessage, ToolFunctionSpec } from "./provider.ts";
export { OllamaProvider } from "./ollama.ts";
export { CloudProvider } from "./cloud.ts";
export { FailoverProvider } from "./failover.ts";

/** Strip a `cloud:` routing prefix — leaves the bare model id. */
export const bareModel = (spec: string): string => spec.replace(/^cloud:/, "");

const TRANSIENT =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|fetch failed|socket hang up|network|\b(500|502|503|504)\b|timed out|timeout/i;
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a provider so transient failures retry. 5xx / network errors get a few
 * exponential-backoff attempts (`tries`). A 429 is treated as "slow down, not
 * broken": we wait the server's hinted delay (`try again in Ns` / `Retry-After`,
 * capped at 30s) and keep going until `rateLimitMaxWaitMs` of total waiting is
 * spent — so a tight free-tier TPM budget just paces the office instead of
 * failing the task.
 */
export function withRetry(provider: Provider, tries = config.llmRetries): Provider {
  if (tries <= 1) return provider;
  return {
    label: provider.label,
    model: provider.model,
    async chat(messages: ChatMessage[], tools?: ToolFunctionSpec[]) {
      let attempt = 0;
      let waited = 0;
      for (;;) {
        attempt++;
        try {
          return await provider.chat(messages, tools);
        } catch (err) {
          const msg = String((err as Error).message);
          const limited = RATE_LIMITED.test(msg);
          if (!limited && !TRANSIENT.test(msg)) throw err;

          if (limited) {
            if (waited >= config.rateLimitMaxWaitMs) throw err;
            const hint = msg.match(/(?:try again in|retry-after[:\s]+)\s*([\d.]+)\s*(m?s)?/i);
            let ms = hint
              ? Math.ceil(parseFloat(hint[1]) * (hint[2] === "ms" ? 1 : 1000)) + 500
              : 2000 * attempt;
            ms = Math.min(ms, 30_000);
            console.warn(
              `[llm] ${provider.label} rate-limited — waiting ${(ms / 1000).toFixed(1)}s`,
            );
            await sleep(ms);
            waited += ms;
          } else {
            if (attempt >= tries) throw err;
            await sleep(400 * 2 ** (attempt - 1));
          }
        }
      }
    },
  };
}

/** Resolve one model string to a retry-wrapped base provider. A `cloud:` prefix
 *  routes through the OpenAI-compatible API (`OFFICE_CLOUD_BASE_URL` +
 *  `OFFICE_CLOUD_API_KEY`); anything else is a local Ollama model. */
function resolveOne(model: string): Provider {
  const cloud = /^cloud:(.+)/.exec(model);
  if (cloud) {
    if (!config.cloudApiKey) {
      throw new Error(`model "${model}" needs OFFICE_CLOUD_API_KEY to be set`);
    }
    return withRetry(
      new CloudProvider({
        baseUrl: config.cloudBaseUrl,
        apiKey: config.cloudApiKey,
        model: cloud[1],
      }),
    );
  }
  return withRetry(
    new OllamaProvider({
      host: config.ollamaHost,
      model,
      think: config.think,
      keepAlive: config.ollamaKeepAlive,
    }),
  );
}

/**
 * A cache of providers keyed by the model spec, each wrapped with retry. Roles
 * that name the same spec share one instance. A `|`-separated spec
 * (`cloud:gemini-2.5-flash|qwen3:8b`) becomes a {@link FailoverProvider} that
 * walks the chain on quota / budget exhaustion; a single model has no wrapper.
 */
export function makeProviderPool(): (spec: string) => Provider {
  const cache = new Map<string, Provider>();
  return (spec: string): Provider => {
    let p = cache.get(spec);
    if (!p) {
      const parts = spec
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      p =
        parts.length > 1
          ? new FailoverProvider(
              parts.map((m) => ({ provider: resolveOne(m), model: bareModel(m) })),
            )
          : resolveOne(parts[0] ?? spec);
      cache.set(spec, p);
    }
    return p;
  };
}

/** Which local model a role runs on: explicit OFFICE_MODEL_<ROLE> override, then
 *  the role's tier (config.modelHeavy / modelLight), then the global default. */
export function modelForRole(roleKey: string, tier?: "heavy" | "light"): string {
  if (config.roleModels[roleKey]) return config.roleModels[roleKey];
  if (tier === "heavy") return config.modelHeavy;
  if (tier === "light") return config.modelLight;
  return config.model;
}

/**
 * The manager's provider: the OpenAI-compatible cloud API when
 * `OFFICE_MANAGER_PROVIDER=cloud`, otherwise whatever the pool resolves for an
 * explicit `OFFICE_MODEL_MANAGER` / legacy `OFFICE_MANAGER_MODEL` (either may be
 * a `cloud:` model), else the heavy tier.
 */
export function buildManagerProvider(pool: (model: string) => Provider): Provider {
  if (config.managerProvider === "cloud") {
    if (!config.cloudApiKey) {
      throw new Error("OFFICE_MANAGER_PROVIDER=cloud requires OFFICE_CLOUD_API_KEY to be set");
    }
    return withRetry(
      new CloudProvider({
        baseUrl: config.cloudBaseUrl,
        apiKey: config.cloudApiKey,
        model: config.managerModel || config.model,
      }),
    );
  }
  return pool(config.roleModels.manager || config.managerModel || config.modelHeavy);
}
