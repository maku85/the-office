import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Bus } from "./bus.ts";
import type { OfficeEvent } from "../shared/events.ts";

export interface AuditRow {
  id: number;
  ts: string;
  /** goal · task · hire · dismiss · review · approval · cooldown · skill · usage */
  kind: string;
  /** agent id, or "office" / "system" / "broker" */
  actor: string;
  /** JSON string of the salient fields */
  detail: string;
}

const AUDITED = new Set([
  "goal_update",
  "task_update",
  "agent_registered",
  "agent_dismissed",
  "review",
  "approval_request",
  "approval_resolved",
  "cooldown",
  "skill_use",
  "usage",
]);

/**
 * Append-only "who did what" log in its own SQLite file — a durable record of
 * state changes and outcomes, separate from the live Activity stream (ephemeral)
 * and the semantic memory. `attach(bus)` folds a curated slice of the event
 * stream into rows; `recent()` reads them back. Never throws into the office.
 */
export class AuditLog {
  private db: DatabaseSync;
  private off: (() => void) | null = null;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        ts     TEXT NOT NULL DEFAULT (datetime('now')),
        kind   TEXT NOT NULL,
        actor  TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS audit_kind_id ON audit(kind, id);
    `);
  }

  record(kind: string, actor: string, detail: Record<string, unknown> = {}): void {
    try {
      this.db
        .prepare("INSERT INTO audit (kind, actor, detail) VALUES (?, ?, ?)")
        .run(kind, actor, JSON.stringify(detail));
    } catch {
      /* auditing must never break the office */
    }
  }

  attach(bus: Bus): void {
    this.off?.();
    this.off = bus.onEvent((e) => {
      if (AUDITED.has(e.type)) this.fold(e);
    });
  }

  private fold(e: OfficeEvent): void {
    switch (e.type) {
      case "goal_update":
        this.record("goal", "office", {
          goalId: e.goalId,
          status: e.status,
          text: e.text.slice(0, 200),
          commit: e.commit,
          usage: e.usage,
        });
        break;
      case "task_update":
        if (e.status === "done" || e.status === "failed" || e.status === "revision") {
          this.record("task", e.assignee, { taskId: e.taskId, title: e.title, status: e.status });
        }
        break;
      case "agent_registered":
        this.record("hire", e.agent, { role: e.role, model: e.model, desk: e.desk });
        break;
      case "agent_dismissed":
        this.record("dismiss", e.agent, {});
        break;
      case "review":
        this.record("review", e.by, {
          task: e.task,
          verdict: e.verdict,
          feedback: e.feedback?.slice(0, 300),
          suggestions: e.suggestions?.slice(0, 300),
        });
        break;
      case "approval_request":
        this.record("approval", e.agent, {
          requestId: e.requestId,
          action: e.action,
          detail: e.detail?.slice(0, 300),
          decided: false,
        });
        break;
      case "approval_resolved":
        this.record("approval", "broker", {
          requestId: e.requestId,
          approved: e.approved,
          decided: true,
        });
        break;
      case "cooldown":
        this.record("cooldown", "system", { active: e.active, reason: e.reason });
        break;
      case "skill_use":
        this.record("skill", e.agent, { skill: e.skill, found: e.found });
        break;
      case "usage":
        this.record("usage", e.agent, {
          model: e.model,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          ms: e.ms,
          turns: e.turns,
        });
        break;
    }
  }

  /** Newest first. `kind` filters; `limit` (default 200, max 2000) caps. */
  recent(opts: { kind?: string; limit?: number } = {}): AuditRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 2000);
    const sql = opts.kind
      ? "SELECT id, ts, kind, actor, detail FROM audit WHERE kind = ? ORDER BY id DESC LIMIT ?"
      : "SELECT id, ts, kind, actor, detail FROM audit ORDER BY id DESC LIMIT ?";
    const stmt = this.db.prepare(sql);
    const rows = opts.kind ? stmt.all(opts.kind, limit) : stmt.all(limit);
    return rows as unknown as AuditRow[];
  }

  close(): void {
    this.off?.();
    this.off = null;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
