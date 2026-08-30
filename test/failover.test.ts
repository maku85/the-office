import { test } from "node:test";
import assert from "node:assert/strict";
import { FailoverProvider } from "../src/llm/failover.ts";
import type { ChatMessage, Provider } from "../src/llm/provider.ts";
import { config } from "../src/config.ts";

/** A provider whose every `chat()` runs `step()` — return a reply or throw. */
function fake(model: string, step: () => ChatMessage): Provider {
  return {
    label: `fake:${model}`,
    model,
    async chat() {
      return step();
    },
  };
}

const reply = (
  text: string,
  usage?: { inputTokens: number; outputTokens: number },
): ChatMessage => ({
  role: "assistant",
  content: text,
  ...(usage ? { usage } : {}),
});

test("a quota error falls over to the next model within the same call", async () => {
  const chain = new FailoverProvider([
    {
      provider: fake("gem", () => {
        throw new Error('cloud 429: {"error":{"message":"rate limit"}}');
      }),
      model: "gem",
    },
    { provider: fake("qwen", () => reply("hi from qwen")), model: "qwen" },
  ]);

  const r = await chain.chat([]);
  assert.equal(r.content, "hi from qwen");
  assert.equal(chain.model, "qwen");
  assert.equal(chain.label, "fake:qwen");
  assert.equal(chain.lastSwitchReason, "quota");
});

test("a real (non-quota) error propagates without failing over", async () => {
  let qwenTried = false;
  const chain = new FailoverProvider([
    {
      provider: fake("gem", () => {
        throw new TypeError("foo is not a function");
      }),
      model: "gem",
    },
    {
      provider: fake("qwen", () => {
        qwenTried = true;
        return reply("x");
      }),
      model: "qwen",
    },
  ]);

  await assert.rejects(() => chain.chat([]), /foo is not a function/);
  assert.equal(qwenTried, false, "the next model was not tried");
  assert.equal(chain.model, "gem");
});

test("when every model is exhausted the last error is rethrown", async () => {
  const chain = new FailoverProvider([
    {
      provider: fake("a", () => {
        throw new Error("cloud 429: too many requests");
      }),
      model: "a",
    },
    {
      provider: fake("b", () => {
        throw new Error("cloud 429: insufficient_quota");
      }),
      model: "b",
    },
  ]);
  await assert.rejects(() => chain.chat([]), /insufficient_quota/);
});

test("crossing a model's token budget skips it on the next call", async () => {
  const prev = { ...config.modelBudget };
  config.modelBudget = { big: 100 };
  try {
    let bigCalls = 0;
    const chain = new FailoverProvider([
      {
        provider: fake("big", () => {
          bigCalls++;
          return reply("big", { inputTokens: 70, outputTokens: 60 });
        }),
        model: "big",
      },
      { provider: fake("small", () => reply("small")), model: "small" },
    ]);

    const first = await chain.chat([]);
    assert.equal(first.content, "big"); // budget not yet spent
    assert.equal(chain.usageFor("big"), 130);

    const second = await chain.chat([]);
    assert.equal(second.content, "small"); // 130 >= 100 → skipped
    assert.equal(chain.model, "small");
    assert.equal(chain.lastSwitchReason, "budget");
    assert.equal(bigCalls, 1, "the over-budget model was not called again");

    assert.deepEqual(chain.usageByModel(), { big: 130, small: 0 });
  } finally {
    config.modelBudget = prev;
  }
});

test("a single-entry chain still works and never switches", async () => {
  const chain = new FailoverProvider([
    { provider: fake("solo", () => reply("ok")), model: "solo" },
  ]);
  assert.equal((await chain.chat([])).content, "ok");
  assert.equal(chain.lastSwitchReason, undefined);
});
