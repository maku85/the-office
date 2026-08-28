import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProviderPool, buildManagerProvider, modelForRole } from "../src/llm/index.ts";
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
  const prev = config.openaiApiKey;
  config.openaiApiKey = "test-key";
  try {
    const p = pool("cloud:gpt-4o-mini");
    assert.equal(p.label, "openai:gpt-4o-mini");
    assert.equal(pool("cloud:gpt-4o-mini"), p, "cached");
    assert.notEqual(pool("qwen3:8b").label, p.label, "local models still go to Ollama");
  } finally {
    config.openaiApiKey = prev;
  }
});

test("a cloud: model without an API key fails loudly", () => {
  const pool = makeProviderPool();
  const prev = config.openaiApiKey;
  config.openaiApiKey = "";
  try {
    assert.throws(() => pool("cloud:gpt-4o-mini"), /OFFICE_OPENAI_API_KEY/);
  } finally {
    config.openaiApiKey = prev;
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
