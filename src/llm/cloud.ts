import type { ChatMessage, Provider, ProviderToolCall, ToolFunctionSpec } from "./provider.ts";

export interface CloudOptions {
  /** e.g. https://api.openai.com/v1, https://api.groq.com/openai/v1,
   *  https://openrouter.ai/api/v1, http://localhost:1234/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Any OpenAI-compatible /chat/completions endpoint — the de-facto wire format
 * spoken by OpenAI, Groq, Gemini's compat endpoint, OpenRouter (incl. Claude),
 * LM Studio, vLLM, llama.cpp, Ollama's own /v1. The "OAI*" shapes below just
 * name that protocol, not the vendor. Handy for running a role (or the manager)
 * on a cloud model while the rest stay local.
 */
export class CloudProvider implements Provider {
  readonly model: string;
  readonly label: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: CloudOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.label = `cloud:${opts.model}`;
  }

  async chat(messages: ChatMessage[], tools?: ToolFunctionSpec[]): Promise<ChatMessage> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toOpenAI),
      temperature: 0.4,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`cloud ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message: OAIMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = fromOpenAI(json.choices?.[0]?.message);
    if (json.usage) {
      message.usage = {
        inputTokens: json.usage.prompt_tokens ?? 0,
        outputTokens: json.usage.completion_tokens ?? 0,
      };
    }
    return message;
  }
}

function toOpenAI(m: ChatMessage): OAIMessage {
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content,
      tool_call_id: m.tool_call_id ?? m.tool_name ?? "call_0",
      name: m.tool_name,
    };
  }
  if (m.role === "assistant" && m.tool_calls?.length) {
    return {
      role: "assistant",
      content: m.content || "",
      tool_calls: m.tool_calls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments ?? {}),
        },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function fromOpenAI(m: OAIMessage | undefined): ChatMessage {
  if (!m) return { role: "assistant", content: "" };
  const tool_calls: ProviderToolCall[] | undefined = m.tool_calls?.map((tc) => ({
    id: tc.id,
    function: {
      name: tc.function.name,
      arguments: safeParseObject(tc.function.arguments),
    },
  }));
  return { role: "assistant", content: m.content ?? "", tool_calls };
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
