import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLocalProviderPool, buildManagerProvider, modelForRole } from "../src/llm/index.ts";
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

test("the local provider pool returns one cached provider per model name", () => {
  const local = makeLocalProviderPool();
  const a = local(config.model);
  assert.equal(a, local(config.model), "same model → same instance");
  assert.equal(a.label, `ollama:${config.model}`);
  assert.notEqual(local("some-other-model"), a, "different model → different instance");
});

test("by default the manager shares the workers' local provider", () => {
  // modelHeavy / roleModels.manager / managerModel all unset → falls back to config.model
  const local = makeLocalProviderPool();
  const manager = buildManagerProvider(local);
  assert.equal(manager.label, `ollama:${config.model}`);
  assert.equal(manager, local(config.model), "same instance as the default worker provider");
});
