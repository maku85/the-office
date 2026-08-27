import type {
  ChatMessage,
  Provider,
  ProviderToolCall,
  ToolFunctionSpec,
} from "./provider.ts";

export interface OpenAIOptions {
  /** e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, http://localhost:1234/v1 */
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
 * Any OpenAI-compatible /chat/completions endpoint: OpenAI, OpenRouter (incl.
 * Claude models), LM Studio, vLLM, llama.cpp, Ollama's own /v1. Handy for
 * running the manager on a cloud model while the workers stay local.
 */
export class OpenAIProvider implements Provider {
  readonly model: string;
  readonly label: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OpenAIOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.label = `openai:${opts.model}`;
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
      throw new Error(`openai ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message: OAIMessage }> };
    return fromOpenAI(json.choices?.[0]?.message);
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
