import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import type { Bus } from "./bus.ts";

export type PermDecision = "allow" | "deny" | "ask";

export interface PermRequest {
  agent: string;
  tool: string;
  /** Stable identifier for "always allow" grants, e.g. the shell verb. */
  key: string;
  /** Human-readable description of exactly what will run. */
  detail: string;
  /** Directory the action would run in — lets rules path-check arguments. */
  cwd?: string;
}

export interface PermRule {
  name: string;
  /** Return a decision, or null to fall through to the next rule. */
  match(req: PermRequest): PermDecision | null;
}

export interface PermVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Decides whether a risky action may run. Rules are consulted in order;
 * the first that returns `allow`/`deny` wins, `ask` escalates to a human,
 * and no match also asks. Humans can grant an action for the whole session.
 */
export class PermissionBroker {
  private readonly bus: Bus;
  private readonly rules: PermRule[];
  private readonly timeoutMs: number;
  private readonly grants = new Set<string>();
  private readonly pending = new Map<
    string,
    {
      resolve: (approved: boolean) => void;
      grantKey: string;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(bus: Bus, rules: PermRule[], timeoutMs = config.approvalTimeout * 1000) {
    this.bus = bus;
    this.rules = rules;
    this.timeoutMs = timeoutMs;
  }

  async check(req: PermRequest): Promise<PermVerdict> {
    const grantKey = `${req.tool}:${req.key}`;
    if (this.grants.has(grantKey)) {
      return { ok: true, reason: "session grant" };
    }

    for (const rule of this.rules) {
      const decision = rule.match(req);
      if (decision === "allow") {
        this.bus.emit({
          type: "log",
          agent: req.agent,
          level: "info",
          text: `permission: ${req.tool} allowed by ${rule.name} — ${req.detail}`,
        });
        return { ok: true, reason: rule.name };
      }
      if (decision === "deny") {
        this.bus.emit({
          type: "log",
          agent: req.agent,
          level: "warn",
          text: `permission: ${req.tool} denied by ${rule.name} — ${req.detail}`,
        });
        return { ok: false, reason: rule.name };
      }
      if (decision === "ask") break;
    }

    const requestId = randomUUID();
    this.bus.emit({
      type: "approval_request",
      agent: req.agent,
      requestId,
      action: req.tool,
      detail: req.detail,
    });
    const approved = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (this.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          this.bus.emit({
            type: "log",
            agent: req.agent,
            level: "warn",
            text: `permission: ${req.tool} auto-denied — no response in ${Math.round(
              this.timeoutMs / 1000,
            )}s`,
          });
          this.bus.emit({ type: "approval_resolved", requestId, approved: false });
          resolve(false);
        }, this.timeoutMs);
      }
      this.pending.set(requestId, { resolve, grantKey, timer });
    });
    return { ok: approved, reason: approved ? "human approved" : "human denied" };
  }

  /** Called by the server when a decision arrives from the UI. */
  resolve(requestId: string, approved: boolean, remember = false): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (approved && remember) this.grants.add(entry.grantKey);
    entry.resolve(approved);
    this.bus.emit({ type: "approval_resolved", requestId, approved });
  }
}
