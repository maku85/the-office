import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Memory, type EmbedFn } from "../src/orchestrator/memory.ts";
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
