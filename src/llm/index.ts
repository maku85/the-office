import { config } from "../config.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAIProvider } from "./openai.ts";
import type { ChatMessage, Provider, ToolFunctionSpec } from "./provider.ts";

export type { Provider, ChatMessage, ToolFunctionSpec } from "./provider.ts";
export { OllamaProvider } from "./ollama.ts";
export { OpenAIProvider } from "./openai.ts";

const TRANSIENT =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|fetch failed|socket hang up|network|\b(429|500|502|503|504)\b|timed out|timeout/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wrap a provider so transient network / 5xx failures retry with backoff. */
export function withRetry(provider: Provider, tries = config.llmRetries): Provider {
  if (tries <= 1) return provider;
  return {
    label: provider.label,
    model: provider.model,
    async chat(messages: ChatMessage[], tools?: ToolFunctionSpec[]) {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          return await provider.chat(messages, tools);
        } catch (err) {
          lastErr = err;
          if (attempt === tries || !TRANSIENT.test(String((err as Error).message))) throw err;
          await sleep(400 * 2 ** (attempt - 1));
        }
      }
      throw lastErr;
    },
  };
}

/**
 * A cache of local (Ollama) providers keyed by model name, each wrapped with
 * retry. Roles that share a model share one provider instance, so Ollama is
 * asked for at most one distinct model per tier.
 */
export function makeLocalProviderPool(): (model: string) => Provider {
  const cache = new Map<string, Provider>();
  return (model: string): Provider => {
    let p = cache.get(model);
    if (!p) {
      p = withRetry(
        new OllamaProvider({
          host: config.ollamaHost,
          model,
          think: config.think,
          keepAlive: config.ollamaKeepAlive,
        }),
      );
      cache.set(model, p);
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
 * The manager's provider: an OpenAI-compatible cloud endpoint when
 * `OFFICE_MANAGER_PROVIDER=openai`, otherwise a local model (an explicit
 * `OFFICE_MODEL_MANAGER` / legacy `OFFICE_MANAGER_MODEL`, else the heavy tier).
 */
export function buildManagerProvider(local: (model: string) => Provider): Provider {
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
  return local(
    config.roleModels.manager || config.managerModel || config.modelHeavy,
  );
}
