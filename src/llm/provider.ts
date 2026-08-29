/**
 * Provider-neutral chat interface. Agents talk to a {@link Provider}; the office
 * doesn't care whether it is Ollama, an OpenAI-compatible endpoint, or anything
 * else. Message and tool shapes follow the Ollama flavour (arguments as parsed
 * objects); each provider translates at its own boundary.
 */

export interface ToolFunctionSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderToolCall {
  id?: string;
  function: {
    name: string;
    /** Always a parsed object by the time the agent loop sees it. */
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** present on assistant turns that call tools */
  tool_calls?: ProviderToolCall[];
  /** links a role:"tool" result to its call (Ollama style) */
  tool_name?: string;
  /** links a role:"tool" result to its call (OpenAI style) */
  tool_call_id?: string;
  /** present on assistant turns when the model exposes its thinking */
  thinking?: string;
  /** token counts for this one exchange, when the provider reports them */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Provider {
  /** Short identifier for logs / the UI, e.g. `ollama:qwen3:8b`. For a failover
   *  chain this reflects the *currently active* model. */
  readonly label: string;
  readonly model: string;
  /** Why the active model last changed — set by a failover chain, read by the
   *  agent to emit an `agent_model` event. Undefined for a plain provider. */
  readonly lastSwitchReason?: "budget" | "quota" | "error";
  chat(messages: ChatMessage[], tools?: ToolFunctionSpec[]): Promise<ChatMessage>;
}
