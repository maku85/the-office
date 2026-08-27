import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { embed } from "../llm/ollama.ts";
import type { Bus } from "./bus.ts";
import type { MemoryKind } from "../shared/events.ts";

export type EmbedFn = (inputs: string[]) => Promise<number[][]>;

export interface MemoryRow {
  id: number;
  kind: MemoryKind;
  agent: string | null;
  text: string;
  createdAt: string;
}

/**
 * Persistent office memory: a shared blackboard of facts and decisions plus
 * free-form notes, all stored in one SQLite table. Notes carry an embedding
 * (nomic-embed-text) so agents can recall relevant context across tasks and
 * across model reloads.
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
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        agent      TEXT,
        text       TEXT NOT NULL,
        embedding  BLOB,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
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

  async remember(input: { kind: MemoryKind; agent?: string; text: string }): Promise<number> {
    const text = input.text.trim();
    if (!text) return -1;

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
      .prepare("INSERT INTO memory (kind, agent, text, embedding) VALUES (?, ?, ?, ?)")
      .run(input.kind, input.agent ?? null, text, blob);
    const id = Number(info.lastInsertRowid);

    this.bus.emit({ type: "memory_note", id, kind: input.kind, agent: input.agent, text });
    return id;
  }

  /** Recent facts and decisions, newest first. */
  blackboard(limit = 20): MemoryRow[] {
    return this.rows(
      this.db
        .prepare(
          "SELECT id, kind, agent, text, created_at FROM memory " +
            "WHERE kind IN ('fact','decision') ORDER BY id DESC LIMIT ?",
        )
        .all(limit),
    );
  }

  /** Top-k memories most relevant to `query` (cosine), or recent on fallback. */
  async recall(query: string, k = 4): Promise<MemoryRow[]> {
    const all = this.db
      .prepare("SELECT id, kind, agent, text, embedding, created_at FROM memory")
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
    const scored = embedded.map((r) => {
      const buf = r.embedding as Buffer;
      const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      return { row: r, score: dot(q, normalize(Array.from(v))) };
    });
    scored.sort((a, b) => b.score - a.score);
    return this.rows(scored.slice(0, k).map((s) => s.row));
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
