import { config } from "../config.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAIProvider } from "./openai.ts";
import type { ChatMessage, Provider, ToolFunctionSpec } from "./provider.ts";

export type { Provider, ChatMessage, ToolFunctionSpec } from "./provider.ts";
export { OllamaProvider } from "./ollama.ts";
export { OpenAIProvider } from "./openai.ts";

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
            let ms = hint ? Math.ceil(parseFloat(hint[1]) * (hint[2] === "ms" ? 1 : 1000)) + 500 : 2000 * attempt;
            ms = Math.min(ms, 30_000);
            console.warn(`[llm] ${provider.label} rate-limited — waiting ${(ms / 1000).toFixed(1)}s`);
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

/**
 * A cache of providers keyed by model string, each wrapped with retry. Roles
 * that name the same model share one instance. A `cloud:` / `openai:` prefix
 * (e.g. `cloud:gpt-4o-mini`) routes that role through the OpenAI-compatible
 * endpoint (`OFFICE_OPENAI_BASE_URL` + `OFFICE_OPENAI_API_KEY`); anything else is
 * a local Ollama model.
 */
export function makeProviderPool(): (model: string) => Provider {
  const cache = new Map<string, Provider>();
  return (model: string): Provider => {
    let p = cache.get(model);
    if (!p) {
      const cloud = /^(cloud|openai):(.+)/.exec(model);
      if (cloud) {
        if (!config.openaiApiKey) {
          throw new Error(`model "${model}" needs OFFICE_OPENAI_API_KEY to be set`);
        }
        p = withRetry(
          new OpenAIProvider({
            baseUrl: config.openaiBaseUrl,
            apiKey: config.openaiApiKey,
            model: cloud[2],
          }),
        );
      } else {
        p = withRetry(
          new OllamaProvider({
            host: config.ollamaHost,
            model,
            think: config.think,
            keepAlive: config.ollamaKeepAlive,
          }),
        );
      }
      cache.set(model, p);
    }
    return p;
  };
}

/** @deprecated use {@link makeProviderPool} (now also handles `cloud:` models). */
export const makeLocalProviderPool = makeProviderPool;

/** Which local model a role runs on: explicit OFFICE_MODEL_<ROLE> override, then
 *  the role's tier (config.modelHeavy / modelLight), then the global default. */
export function modelForRole(roleKey: string, tier?: "heavy" | "light"): string {
  if (config.roleModels[roleKey]) return config.roleModels[roleKey];
  if (tier === "heavy") return config.modelHeavy;
  if (tier === "light") return config.modelLight;
  return config.model;
}

/**
 * The manager's provider: an OpenAI-compatible cloud endpoint when
 * `OFFICE_MANAGER_PROVIDER=openai`, otherwise whatever the pool resolves for an
 * explicit `OFFICE_MODEL_MANAGER` / legacy `OFFICE_MANAGER_MODEL` (either may be
 * a `cloud:` model), else the heavy tier.
 */
export function buildManagerProvider(pool: (model: string) => Provider): Provider {
  if (config.managerProvider === "openai") {
    if (!config.openaiApiKey) {
      throw new Error(
        "OFFICE_MANAGER_PROVIDER=openai requires OFFICE_OPENAI_API_KEY to be set",
      );
    }
    return withRetry(
      new OpenAIProvider({
        baseUrl: config.openaiBaseUrl,
        apiKey: config.openaiApiKey,
        model: config.managerModel || config.model,
      }),
    );
  }
  return pool(config.roleModels.manager || config.managerModel || config.modelHeavy);
}
