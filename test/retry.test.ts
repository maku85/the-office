import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/llm/index.ts";
import { config } from "../src/config.ts";
import type { ChatMessage, Provider } from "../src/llm/provider.ts";

const RL =
  'cloud 429: {"error":{"message":"Rate limit reached, please try again in 0s","code":"rate_limit_exceeded"}}';

function provider(behaviour: () => Promise<ChatMessage>): Provider & { calls: number } {
  const p = {
    label: "fake",
    model: "fake",
    calls: 0,
    async chat() {
      p.calls++;
      return behaviour();
    },
  };
  return p;
}

const ok: ChatMessage = { role: "assistant", content: "hi" };

test("retries a transient failure and then succeeds", async () => {
  let n = 0;
  const p = provider(() => {
    n++;
    return n < 3
      ? Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:11434"))
      : Promise.resolve(ok);
  });
  const wrapped = withRetry(p, 3);
  assert.deepEqual(await wrapped.chat([], undefined), ok);
  assert.equal(p.calls, 3);
});

test("gives up after `tries` transient failures", async () => {
  const p = provider(() => Promise.reject(new Error("503 Service Unavailable")));
  await assert.rejects(() => withRetry(p, 3).chat([], undefined), /503/);
  assert.equal(p.calls, 3);
});

test("does not retry a non-transient error", async () => {
  const p = provider(() => Promise.reject(new Error("model 'ghost' not found")));
  await assert.rejects(() => withRetry(p, 3).chat([], undefined), /not found/);
  assert.equal(p.calls, 1);
});

test("tries <= 1 returns the provider untouched", () => {
  const p = provider(() => Promise.resolve(ok));
  assert.equal(withRetry(p, 1), p);
});

test("a 429 is paced (waited out), not counted against `tries`", async () => {
  let n = 0;
  const p = provider(() => {
    n++;
    return n < 3 ? Promise.reject(new Error(RL)) : Promise.resolve(ok);
  });
  assert.deepEqual(await withRetry(p, 2).chat([], undefined), ok);
  assert.equal(p.calls, 3, "kept going past the 2 transient retries");
});

test("gives up on a persistent 429 once the wait budget is spent", async () => {
  const prev = config.rateLimitMaxWaitMs;
  config.rateLimitMaxWaitMs = 200;
  try {
    const p = provider(() => Promise.reject(new Error(RL)));
    await assert.rejects(() => withRetry(p, 3).chat([], undefined), /429/);
  } finally {
    config.rateLimitMaxWaitMs = prev;
  }
});
