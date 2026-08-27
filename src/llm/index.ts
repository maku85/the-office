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
 * Build the providers each role uses. Workers are always local; the manager can
 * be pointed at a different local model or an OpenAI-compatible cloud endpoint.
 */
export function buildProviders(): { worker: Provider; manager: Provider } {
  const workerRaw = new OllamaProvider({
    host: config.ollamaHost,
    model: config.model,
    think: config.think,
  });

  let managerRaw: Provider = workerRaw;
  if (config.managerProvider === "openai") {
    if (!config.openaiApiKey) {
      throw new Error(
        "OFFICE_MANAGER_PROVIDER=openai requires OFFICE_OPENAI_API_KEY to be set",
      );
    }
    managerRaw = new OpenAIProvider({
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
      model: config.managerModel || config.model,
    });
  } else if (config.managerModel && config.managerModel !== config.model) {
    managerRaw = new OllamaProvider({
      host: config.ollamaHost,
      model: config.managerModel,
      think: config.think,
    });
  }

  const worker = withRetry(workerRaw);
  const manager = managerRaw === workerRaw ? worker : withRetry(managerRaw);
  return { worker, manager };
}
