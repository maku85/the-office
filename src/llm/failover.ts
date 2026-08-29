import { config } from "../config.ts";
import type { ChatMessage, Provider, ToolFunctionSpec } from "./provider.ts";

/**
 * A chain of providers tried in order. `chat()` uses the first link that is
 * neither `dead` nor over its token budget; on a quota/auth/"model gone" error
 * (after each link's own `withRetry` has given up) it marks that link dead and
 * falls through to the next — within the same call. When a link's cumulative
 * token use crosses its `OFFICE_MODEL_BUDGET`, the *next* call skips it.
 *
 * Only quota/billing/rate-limit/404-class errors trigger failover; a real code
 * error from the model propagates untouched. If nothing is left, the last error
 * is rethrown.
 */
export interface FailoverEntry {
  provider: Provider;
  /** bare model id (no `cloud:` / `openai:` prefix) — the budget + event key */
  model: string;
}

interface Link extends FailoverEntry {
  used: number;
  dead: boolean;
}

const QUOTA =
  /\b(429|401|402|403|404)\b|insufficient_quota|exceeded your current quota|quota\b|billing|rate.?limit|too many requests|model_not_found|does not exist|no access|unauthor/i;

export class FailoverProvider implements Provider {
  private readonly links: Link[];
  private i = 0;
  lastSwitchReason?: "budget" | "quota" | "error";

  constructor(entries: FailoverEntry[]) {
    if (entries.length === 0) throw new Error("FailoverProvider needs at least one entry");
    this.links = entries.map((e) => ({ ...e, used: 0, dead: false }));
  }

  get label(): string {
    return this.links[this.i]?.provider.label ?? "failover";
  }

  get model(): string {
    return this.links[this.i]?.model ?? "?";
  }

  /** Tokens counted against `model` so far this process (across every link that names it). */
  usageFor(model: string): number {
    return this.links.reduce((n, l) => (l.model === model ? n + l.used : n), 0);
  }

  /** {model → tokens used} for every link in the chain. */
  usageByModel(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of this.links) out[l.model] = (out[l.model] ?? 0) + l.used;
    return out;
  }

  private budget(model: string): number {
    return config.modelBudget[model] ?? Infinity;
  }

  /** Move `i` to the next usable link. Returns false when the chain is spent. */
  private advance(reason: "budget" | "quota" | "error"): boolean {
    for (let n = this.i + 1; n < this.links.length; n++) {
      const l = this.links[n];
      if (!l.dead && l.used < this.budget(l.model)) {
        this.i = n;
        this.lastSwitchReason = reason;
        console.warn(`[llm] failover → ${l.provider.label} (${reason})`);
        return true;
      }
    }
    return false;
  }

  async chat(messages: ChatMessage[], tools?: ToolFunctionSpec[]): Promise<ChatMessage> {
    let lastErr: unknown;
    while (this.i < this.links.length) {
      const l = this.links[this.i];
      if (l.dead) {
        if (this.advance("error")) continue;
        break;
      }
      if (l.used >= this.budget(l.model)) {
        if (this.advance("budget")) continue;
        break;
      }

      try {
        const reply = await l.provider.chat(messages, tools);
        if (reply.usage) l.used += reply.usage.inputTokens + reply.usage.outputTokens;
        return reply;
      } catch (err) {
        lastErr = err;
        if (!QUOTA.test(String((err as Error).message))) throw err; // real error — propagate
        l.dead = true;
        if (!this.advance("quota")) break;
      }
    }
    throw lastErr ?? new Error(`all ${this.links.length} models in the chain are exhausted`);
  }
}
