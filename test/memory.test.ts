import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Memory, type EmbedFn } from "../src/orchestrator/memory.ts";
import { config } from "../src/config.ts";
import { nullBus, tmpDir } from "./helpers.ts";

/** Deterministic 3-D "embeddings" keyed by a word in the text. */
const VECTORS: Record<string, number[]> = {
  cats: [1, 0, 0],
  dogs: [0.9, 0.1, 0],
  finance: [0, 1, 0],
  weather: [0, 0, 1],
};
const fakeEmbed: EmbedFn = (inputs) =>
  Promise.resolve(
    inputs.map((s) => {
      for (const [word, vec] of Object.entries(VECTORS)) if (s.includes(word)) return vec;
      return [0, 0, 0];
    }),
  );

async function freshMemory(embed: EmbedFn = fakeEmbed): Promise<Memory> {
  const dir = await tmpDir("mem");
  return new Memory(path.join(dir, "m.db"), nullBus, embed);
}

async function freshMemoryAt(
  embed: EmbedFn = fakeEmbed,
): Promise<{ m: Memory; dbPath: string }> {
  const dir = await tmpDir("mem");
  const dbPath = path.join(dir, "m.db");
  return { m: new Memory(dbPath, nullBus, embed), dbPath };
}

/** Backdate a row so recency-weighted recall sees it as old. */
function ageRow(dbPath: string, likeText: string, days: number): void {
  const raw = new DatabaseSync(dbPath);
  raw
    .prepare(`UPDATE memory SET created_at = datetime('now', ?) WHERE text LIKE ?`)
    .run(`-${days} days`, `%${likeText}%`);
  raw.close();
}

test("blackboard returns facts and decisions newest-first, excluding notes", async () => {
  const m = await freshMemory();
  await m.remember({ kind: "fact", text: "fact about cats" });
  await m.remember({ kind: "note", text: "note about dogs" });
  await m.remember({ kind: "decision", text: "decision about finance" });
  assert.deepEqual(
    m.blackboard().map((r) => r.kind),
    ["decision", "fact"],
  );
  m.close();
});

test("recall ranks stored memories by cosine similarity to the query", async () => {
  const m = await freshMemory();
  await m.remember({ kind: "note", text: "all about cats" });
  await m.remember({ kind: "note", text: "all about finance" });
  await m.remember({ kind: "note", text: "all about weather" });
  const hits = await m.recall("a question about dogs", 2);
  assert.equal(hits[0].text, "all about cats"); // dogs vector is closest to cats
  assert.equal(hits.length, 2);
  m.close();
});

test("recall falls back to most-recent when embeddings are unavailable", async () => {
  const down: EmbedFn = () => Promise.reject(new Error("ollama offline"));
  const m = await freshMemory(down);
  await m.remember({ kind: "note", text: "first" });
  await m.remember({ kind: "note", text: "second" });
  await m.remember({ kind: "note", text: "third" });
  const hits = await m.recall("anything", 2);
  assert.deepEqual(
    hits.map((r) => r.text),
    ["third", "second"],
  );
  m.close();
});

test("memory persists across reopen", async () => {
  const dir = await tmpDir("mem");
  const dbPath = path.join(dir, "m.db");
  const first = new Memory(dbPath, nullBus, fakeEmbed);
  await first.remember({ kind: "fact", text: "durable fact about cats" });
  first.close();

  const second = new Memory(dbPath, nullBus, fakeEmbed);
  assert.equal(second.blackboard()[0]?.text, "durable fact about cats");
  second.close();
});

test("empty text is not stored", async () => {
  const m = await freshMemory();
  const id = await m.remember({ kind: "note", text: "   " });
  assert.equal(id, -1);
  assert.equal(m.blackboard().length, 0);
  m.close();
});

test("recall: importance breaks a cosine tie", async () => {
  const m = await freshMemory();
  // both texts embed to the same vector (keyword "cats") but share few words,
  // so the dedup leaves them as two rows with an identical cosine to the query
  await m.remember({ kind: "note", text: "a low-priority tidbit mentioning cats", importance: 0.05 });
  await m.remember({ kind: "note", text: "the crucial durable takeaway involving cats", importance: 0.95 });
  const hits = await m.recall("a question about cats", 2);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].text.includes("crucial durable takeaway"));
  m.close();
});

test("recall: recency breaks a cosine tie", async () => {
  const prev = config.recallHalfLifeDays;
  config.recallHalfLifeDays = 7;
  try {
    const { m, dbPath } = await freshMemoryAt();
    await m.remember({ kind: "note", text: "some dusty archived trivia mentioning cats", importance: 0.5 });
    await m.remember({ kind: "note", text: "a brand new observation involving cats", importance: 0.5 });
    ageRow(dbPath, "dusty archived trivia", 60);
    const hits = await m.recall("something about cats", 2);
    assert.ok(hits[0].text.includes("brand new observation"));
    m.close();
  } finally {
    config.recallHalfLifeDays = prev;
  }
});

test("remember: a near-identical memory reinforces instead of duplicating", async () => {
  const m = await freshMemory();
  const first = await m.remember({
    kind: "fact",
    text: "the build script must run before the tests every single time",
  });
  const second = await m.remember({
    kind: "fact",
    text: "the build script must run before the tests, every time",
  });
  assert.equal(second, first); // same row id — reinforced, not inserted
  const hits = await m.recall("build script tests", 5);
  assert.equal(hits.filter((r) => r.text.includes("build script")).length, 1);
  assert.ok(hits[0].importance > 0.7); // 0.7 default for fact, bumped by +0.1
  m.close();
});

test("reflect: distils unconsolidated notes into insights and weakens the sources", async () => {
  const m = await freshMemory();
  const notes = [
    "shipped the landing page as one html file with inline css",
    "the designer handed over a figma-style spec before any code",
    "qa caught a broken keyboard handler on the first review pass",
    "developer split the game into three modules then had to inline them",
    "researcher pulled the api limits into a table up front",
    "writer produced the readme from the finished project only",
    "the build broke because a script tag pointed at a missing file",
    "manager reassigned the export task after two failed attempts",
    "analyst wrote acceptance criteria the reviewer could check",
    "devops skipped the container step, plain node was enough",
  ];
  for (const t of notes) await m.remember({ kind: "note", text: t });

  const summarize = async (rows: { text: string }[]) => {
    assert.equal(rows.length, 10);
    return ["- Prefer a single self-contained file for small deliverables"];
  };
  const added = await m.reflect(summarize, { agent: "carol" });
  assert.equal(added.length, 1);

  const board = m.blackboard();
  assert.equal(board[0].kind, "insight"); // insights float to the top
  assert.ok(board[0].text.includes("self-contained file"));

  // sources are consolidated → a second pass has nothing to chew on
  const again = await m.reflect(summarize, { agent: "carol" });
  assert.deepEqual(again, []);

  // and their importance was halved (0.4 default note → ~0.2)
  const src = await m.recall("the build broke script tag", 12);
  const note = src.find((r) => r.kind === "note");
  assert.ok(note && note.importance < 0.3);
  m.close();
});

test("reflect: no-op below the minimum note count", async () => {
  const m = await freshMemory();
  await m.remember({ kind: "note", text: "just one lonely note here" });
  let called = false;
  const added = await m.reflect(async () => {
    called = true;
    return ["should not happen"];
  });
  assert.equal(called, false);
  assert.deepEqual(added, []);
  m.close();
});

test("opens a pre-importance database and migrates it", async () => {
  const dir = await tmpDir("mem");
  const dbPath = path.join(dir, "legacy.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, agent TEXT, text TEXT NOT NULL, embedding BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  legacy.prepare("INSERT INTO memory (kind, text) VALUES ('fact', ?)").run("legacy fact about cats");
  legacy.close();

  const m = new Memory(dbPath, nullBus, fakeEmbed);
  const row = m.blackboard()[0];
  assert.equal(row.text, "legacy fact about cats");
  assert.equal(row.importance, 0.5); // backfilled by the migration default
  await m.remember({ kind: "decision", text: "a new decision about dogs" });
  m.close();
});
