import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeProviderPool,
  buildManagerProvider,
  modelForRole,
  bareModel,
} from "../src/llm/index.ts";
import { FailoverProvider } from "../src/llm/failover.ts";
import { config } from "../src/config.ts";

test("modelForRole: tier maps to its model, override wins, no tier = default", () => {
  // env unset in tests → both tiers collapse to config.model
  assert.equal(modelForRole("developer", "heavy"), config.modelHeavy);
  assert.equal(modelForRole("analyst", "light"), config.modelLight);
  assert.equal(modelForRole("whatever", undefined), config.model);

  config.roleModels.developer = "qwen3:14b";
  try {
    assert.equal(modelForRole("developer", "heavy"), "qwen3:14b", "override beats tier");
    assert.equal(modelForRole("qa", "heavy"), config.modelHeavy, "other heavy roles unaffected");
  } finally {
    delete config.roleModels.developer;
  }
});

test("a cloud: model routes through the OpenAI-compatible endpoint", () => {
  const pool = makeProviderPool();
  const prev = config.cloudApiKey;
  config.cloudApiKey = "test-key";
  try {
    const p = pool("cloud:gpt-4o-mini");
    assert.equal(p.label, "cloud:gpt-4o-mini");
    assert.equal(pool("cloud:gpt-4o-mini"), p, "cached");
    assert.notEqual(pool("qwen3:8b").label, p.label, "local models still go to Ollama");
  } finally {
    config.cloudApiKey = prev;
  }
});

test("a cloud: model without an API key fails loudly", () => {
  const pool = makeProviderPool();
  const prev = config.cloudApiKey;
  config.cloudApiKey = "";
  try {
    assert.throws(() => pool("cloud:gpt-4o-mini"), /OFFICE_CLOUD_API_KEY/);
  } finally {
    config.cloudApiKey = prev;
  }
});

test("a `|` spec builds one cached FailoverProvider over the chain", () => {
  const pool = makeProviderPool();
  const prev = config.cloudApiKey;
  config.cloudApiKey = "test-key";
  try {
    const p = pool("cloud:gemini-2.5-flash|qwen3:8b");
    assert.ok(p instanceof FailoverProvider);
    assert.equal(p.model, "gemini-2.5-flash", "starts on the first link (bare id)");
    assert.equal(pool("cloud:gemini-2.5-flash|qwen3:8b"), p, "cached by the full spec");
    assert.notEqual(pool("qwen3:8b"), p, "a plain model is not wrapped");
    assert.equal(bareModel("cloud:gemini-2.5-flash"), "gemini-2.5-flash");
    assert.equal(bareModel("qwen3:8b"), "qwen3:8b");
  } finally {
    config.cloudApiKey = prev;
  }
});

test("the local provider pool returns one cached provider per model name", () => {
  const local = makeProviderPool();
  const a = local(config.model);
  assert.equal(a, local(config.model), "same model → same instance");
  assert.equal(a.label, `ollama:${config.model}`);
  assert.notEqual(local("some-other-model"), a, "different model → different instance");
});

test("by default the manager shares the workers' local provider", () => {
  // modelHeavy / roleModels.manager / managerModel all unset → falls back to config.model
  const local = makeProviderPool();
  const manager = buildManagerProvider(local);
  assert.equal(manager.label, `ollama:${config.model}`);
  assert.equal(manager, local(config.model), "same instance as the default worker provider");
});
