import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { embed } from "../llm/ollama.ts";
import { config } from "../config.ts";
import type { Bus } from "./bus.ts";
import type { MemoryKind } from "../shared/events.ts";

export type EmbedFn = (inputs: string[]) => Promise<number[][]>;

export interface MemoryRow {
  id: number;
  kind: MemoryKind;
  agent: string | null;
  text: string;
  importance: number;
  createdAt: string;
}

/** Default weight per kind when the caller doesn't pass one (0..1). */
const DEFAULT_IMPORTANCE: Record<MemoryKind, number> = {
  insight: 0.9,
  decision: 0.8,
  fact: 0.7,
  note: 0.4,
};

/**
 * Persistent office memory: a shared blackboard of facts, decisions and
 * distilled insights plus free-form notes, all stored in one SQLite table.
 * Rows carry an embedding (nomic-embed-text) so agents can recall relevant
 * context across tasks and model reloads.
 *
 * Recall ranks by a blend of semantic similarity, recency and importance.
 * A periodic {@link reflect} pass folds recent notes into durable insights.
 *
 * Everything degrades gracefully: if the embedding model is unavailable, rows
 * are still stored (without a vector) and recall falls back to most-recent.
 */
export class Memory {
  private db: DatabaseSync;
  private bus: Bus;
  private warnedNoEmbed = false;
  private readonly embed: EmbedFn;

  constructor(dbPath: string, bus: Bus, embedFn: EmbedFn = embed) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.bus = bus;
    this.embed = embedFn;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL,
        agent        TEXT,
        text         TEXT NOT NULL,
        embedding    BLOB,
        importance   REAL NOT NULL DEFAULT 0.5,
        consolidated INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Migrate DBs created before importance / consolidated existed.
    for (const col of [
      "importance REAL NOT NULL DEFAULT 0.5",
      "consolidated INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.db.exec(`ALTER TABLE memory ADD COLUMN ${col};`);
      } catch {
        /* column already present */
      }
    }
  }

  /** Replay the existing blackboard onto the bus so a fresh UI sees history. */
  replayBlackboard(): void {
    for (const row of this.blackboard(30)) {
      this.bus.emit({
        type: "memory_note",
        id: row.id,
        kind: row.kind,
        agent: row.agent ?? undefined,
        text: row.text,
      });
    }
  }

  async remember(input: {
    kind: MemoryKind;
    agent?: string;
    text: string;
    /** 0..1 — how strongly this should outrank other memories on recall. */
    importance?: number;
  }): Promise<number> {
    const text = input.text.trim();
    if (!text) return -1;

    const importance = clamp01(input.importance ?? DEFAULT_IMPORTANCE[input.kind] ?? 0.5);

    // Zero-LLM dedup: reinforce a near-identical recent memory instead of adding one.
    if (config.memoryDedup > 0) {
      const recent = this.db
        .prepare(
          "SELECT id, text FROM memory WHERE kind = ? AND ifnull(agent, '') = ifnull(?, '') " +
            "ORDER BY id DESC LIMIT 30",
        )
        .all(input.kind, input.agent ?? null) as Array<{ id: number; text: string }>;
      for (const r of recent) {
        if (jaccard(text, String(r.text)) >= config.memoryDedup) {
          this.db
            .prepare(
              "UPDATE memory SET importance = min(1.0, importance + 0.1), " +
                "created_at = datetime('now') WHERE id = ?",
            )
            .run(r.id);
          return Number(r.id);
        }
      }
    }

    let blob: Buffer | null = null;
    try {
      const [vec] = await this.embed([`search_document: ${text}`]);
      if (vec) blob = Buffer.from(Float32Array.from(vec).buffer);
    } catch (err) {
      if (!this.warnedNoEmbed) {
        this.warnedNoEmbed = true;
        this.bus.emit({
          type: "log",
          level: "warn",
          text: `memory: embeddings unavailable (${(err as Error).message}); recall falls back to recent`,
        });
      }
    }

    const info = this.db
      .prepare(
        "INSERT INTO memory (kind, agent, text, embedding, importance) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.kind, input.agent ?? null, text, blob, importance);
    const id = Number(info.lastInsertRowid);

    this.bus.emit({ type: "memory_note", id, kind: input.kind, agent: input.agent, text });
    return id;
  }

  /** Recent facts, decisions and insights — insights first, then newest. */
  blackboard(limit = 20): MemoryRow[] {
    return this.rows(
      this.db
        .prepare(
          "SELECT id, kind, agent, text, importance, created_at FROM memory " +
            "WHERE kind IN ('fact','decision','insight') " +
            "ORDER BY (kind = 'insight') DESC, id DESC LIMIT ?",
        )
        .all(limit),
    );
  }

  /**
   * Top-k memories most relevant to `query`, scored as
   * `wᶜ·cosine + wʳ·recency + wⁱ·importance`. Falls back to most-recent when
   * the embedding model or query vector is unavailable.
   */
  async recall(query: string, k = 4): Promise<MemoryRow[]> {
    const all = this.db
      .prepare(
        "SELECT id, kind, agent, text, embedding, importance, created_at FROM memory",
      )
      .all() as Array<Record<string, unknown>>;
    if (all.length === 0) return [];

    let queryVec: number[] | undefined;
    try {
      [queryVec] = await this.embed([`search_query: ${query}`]);
    } catch {
      queryVec = undefined;
    }

    const embedded = all.filter((r) => r.embedding instanceof Uint8Array);
    if (!queryVec || embedded.length === 0) {
      return this.rows(all.slice(-k).reverse());
    }

    const q = normalize(queryVec);
    const w = config.recallWeights;
    const halfLifeMs = config.recallHalfLifeDays * 86_400_000;
    const now = Date.now();

    const scored = embedded.map((r) => {
      const buf = r.embedding as Buffer;
      const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const cosine = dot(q, normalize(Array.from(v)));
      const age = Math.max(0, now - parseSqliteUtc(String(r.created_at)));
      const recency = Math.exp(-age / halfLifeMs);
      const importance = Number(r.importance ?? 0.5);
      return { row: r, score: w.cosine * cosine + w.recency * recency + w.importance * importance };
    });
    scored.sort((a, b) => b.score - a.score);
    return this.rows(scored.slice(0, k).map((s) => s.row));
  }

  /**
   * Reflection pass: hand the last unconsolidated notes/decisions to
   * `summarize`, store what it returns as `insight` rows, then mark the sources
   * consolidated (and halve their importance so they stop crowding recall).
   * No-ops if fewer than `minNotes` unconsolidated rows exist.
   * Returns the ids of the insights created.
   */
  async reflect(
    summarize: (notes: MemoryRow[]) => Promise<string[]>,
    opts: { lookback?: number; minNotes?: number; agent?: string } = {},
  ): Promise<number[]> {
    const lookback = opts.lookback ?? 20;
    const minNotes = opts.minNotes ?? 8;

    const raw = this.db
      .prepare(
        "SELECT id, kind, agent, text, importance, created_at FROM memory " +
          "WHERE kind IN ('note','decision') AND consolidated = 0 " +
          "ORDER BY id DESC LIMIT ?",
      )
      .all(lookback) as Array<Record<string, unknown>>;
    if (raw.length < minNotes) return [];

    const notes = this.rows(raw).reverse(); // chronological for the prompt
    const lessons = await summarize(notes);

    const ids: number[] = [];
    for (const lesson of lessons) {
      const text = lesson.trim();
      if (!text) continue;
      ids.push(await this.remember({ kind: "insight", agent: opts.agent, text, importance: 0.9 }));
    }

    const srcIds = notes.map((n) => n.id);
    const placeholders = srcIds.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE memory SET consolidated = 1, importance = max(0.05, importance * 0.5) ` +
          `WHERE id IN (${placeholders})`,
      )
      .run(...srcIds);

    return ids.filter((n) => n > 0);
  }

  close(): void {
    this.db.close();
  }

  private rows(raw: Array<Record<string, unknown>>): MemoryRow[] {
    return raw.map((r) => ({
      id: Number(r.id),
      kind: r.kind as MemoryKind,
      agent: (r.agent as string | null) ?? null,
      text: String(r.text),
      importance: Number(r.importance ?? 0.5),
      createdAt: String(r.created_at),
    }));
  }
}

/** Render rows as a compact context block for a prompt. */
export function formatMemories(rows: MemoryRow[]): string {
  return rows
    .map((r) => `- (${r.kind}${r.agent ? `, ${r.agent}` : ""}) ${r.text}`)
    .join("\n");
}

function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/** SQLite `datetime('now')` is "YYYY-MM-DD HH:MM:SS" in UTC. */
function parseSqliteUtc(s: string): number {
  const t = Date.parse(/[TZ]/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? Date.now() : t;
}

/** Jaccard similarity of the two texts' word sets (lowercased, alnum tokens ≥ 3). */
function jaccard(a: string, b: string): number {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

function wordSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}
