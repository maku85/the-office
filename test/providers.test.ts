import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviders } from "../src/llm/index.ts";
import { config } from "../src/config.ts";

test("by default every role shares one local Ollama provider", () => {
  const { worker, manager } = buildProviders();
  assert.equal(worker.label, `ollama:${config.model}`);
  assert.equal(manager, worker, "manager falls back to the worker provider");
});
