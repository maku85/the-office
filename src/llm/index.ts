import { config } from "../config.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./provider.ts";

export type { Provider, ChatMessage, ToolFunctionSpec } from "./provider.ts";
export { OllamaProvider } from "./ollama.ts";
export { OpenAIProvider } from "./openai.ts";

/**
 * Build the providers each role uses. Workers are always local; the manager can
 * be pointed at a different local model or an OpenAI-compatible cloud endpoint.
 */
export function buildProviders(): { worker: Provider; manager: Provider } {
  const worker = new OllamaProvider({
    host: config.ollamaHost,
    model: config.model,
    think: config.think,
  });

  if (config.managerProvider === "openai") {
    if (!config.openaiApiKey) {
      throw new Error(
        "OFFICE_MANAGER_PROVIDER=openai requires OFFICE_OPENAI_API_KEY to be set",
      );
    }
    const manager = new OpenAIProvider({
      baseUrl: config.openaiBaseUrl,
      apiKey: config.openaiApiKey,
      model: config.managerModel || config.model,
    });
    return { worker, manager };
  }

  if (config.managerModel && config.managerModel !== config.model) {
    const manager = new OllamaProvider({
      host: config.ollamaHost,
      model: config.managerModel,
      think: config.think,
    });
    return { worker, manager };
  }

  return { worker, manager: worker };
}
