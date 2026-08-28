import { config } from "../config.ts";
import type { ChatMessage, Provider, ToolFunctionSpec } from "./provider.ts";

export interface OllamaOptions {
  host: string;
  model: string;
  think?: boolean;
  /** Ollama `keep_alive`; "0" unloads the model right after each call. */
  keepAlive?: string | number;
}

/** Talks to Ollama's native /api/chat. Messages already match its wire format. */
export class OllamaProvider implements Provider {
  readonly model: string;
  readonly label: string;
  private readonly host: string;
  private readonly think: boolean;
  private readonly keepAlive?: string | number;

  constructor(opts: OllamaOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.model = opts.model;
    this.think = opts.think ?? false;
    this.keepAlive = opts.keepAlive;
    this.label = `ollama:${opts.model}`;
  }

  async chat(messages: ChatMessage[], tools?: ToolFunctionSpec[]): Promise<ChatMessage> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools,
        stream: false,
        think: this.think,
        keep_alive: this.keepAlive,
        options: { temperature: 0.4 },
      }),
    });
    if (!res.ok) {
      throw new Error(`ollama ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      message: ChatMessage;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const message = json.message;
    if (json.prompt_eval_count != null || json.eval_count != null) {
      message.usage = {
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
      };
    }
    return message;
  }
}

/**
 * Embed one or more strings with the configured embedding model. Memory is
 * always local, so this stays a plain Ollama call regardless of the chat provider.
 */
export async function embed(inputs: string[]): Promise<number[][]> {
  const res = await fetch(`${config.ollamaHost}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.embedModel, input: inputs }),
  });
  if (!res.ok) {
    throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { embeddings: number[][] };
  return json.embeddings;
}
