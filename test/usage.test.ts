import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agents/agent.ts";
import { Office } from "../src/orchestrator/office.ts";
import { config } from "../src/config.ts";
import type { ChatMessage, Provider } from "../src/llm/provider.ts";
import type { AgentLike } from "../src/agents/agent.ts";
import type { Bus } from "../src/orchestrator/bus.ts";
import type { GoalUpdateEvent, UsageEvent } from "../src/shared/events.ts";
import { recordingBus, tick } from "./helpers.ts";

const okBroker = { check: async () => ({ ok: true, reason: "" }) } as never;

/** Provider that replies once (no tool calls) and reports token usage. */
function usageProvider(inTok: number, outTok: number): Provider {
  return {
    label: "cloud:fake",
    model: "fake",
    async chat(): Promise<ChatMessage> {
      return {
        role: "assistant",
        content: "done — produced the thing",
        usage: { inputTokens: inTok, outputTokens: outTok },
      };
    },
  };
}

test("Agent emits a usage event with summed tokens, model label and turn count", async () => {
  const { bus, events } = recordingBus();
  const agent = new Agent({
    id: "bob",
    role: "developer",
    blurb: "builds things",
    desk: "desk_dev",
    systemPrompt: "you build things",
    tools: [],
    provider: usageProvider(140, 25),
    bus,
    broker: okBroker,
    workspace: "/tmp",
    writeRoots: [],
  });

  await agent.runTask("do a thing");

  const u = events.find((e) => e.type === "usage") as UsageEvent | undefined;
  assert.ok(u, "a usage event was emitted");
  assert.equal(u.agent, "bob");
  assert.equal(u.model, "cloud:fake");
  assert.equal(u.inputTokens, 140);
  assert.equal(u.outputTokens, 25);
  assert.equal(u.turns, 1);
  assert.ok(u.ms >= 0);
});

/** Worker/manager fakes that emit a usage event each turn, like a real Agent. */
function usageAgent(id: string, bus: Bus, plan: Array<{ to: string; title: string }>, office: Office): AgentLike {
  return {
    id,
    describe: () => id,
    async runTask(prompt: string) {
      bus.emit({
        type: "usage",
        agent: id,
        model: "cloud:fake",
        inputTokens: 200,
        outputTokens: 50,
        ms: 5,
        turns: 1,
      });
      if (/A new goal has come in/.test(prompt)) {
        for (const p of plan) office.enqueue({ title: p.title, details: "d", assignee: p.to });
        return "planned";
      }
      return "ok";
    },
  };
}

test("the goal's terminal update carries the summed usage of every turn", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  office.setTeam({
    manager: usageAgent("carol", bus, [{ to: "bob", title: "build" }], office),
    workers: [usageAgent("bob", bus, [], office)],
  });

  office.submitGoal("ship it");
  await tick(150);

  const emitted = (events.filter((e) => e.type === "usage") as UsageEvent[]);
  assert.ok(emitted.length >= 2, "manager + worker each measured at least one turn");
  const totalIn = emitted.reduce((s, e) => s + e.inputTokens, 0);
  const totalOut = emitted.reduce((s, e) => s + e.outputTokens, 0);

  const done = (events as GoalUpdateEvent[])
    .filter((e) => e.type === "goal_update" && (e.status === "done" || e.status === "failed"))
    .at(-1);
  assert.ok(done?.usage, "terminal goal_update has a usage total");
  assert.equal(done.usage.inputTokens, totalIn);
  assert.equal(done.usage.outputTokens, totalOut);
  assert.ok(done.usage.ms >= 0);
  assert.equal(done.usage.costUsd, undefined, "no cost column without OFFICE_PRICING");
});

test("the goal update breaks usage down by model when a failover split it", async () => {
  const { bus, events } = recordingBus();
  const office = new Office(bus, null, null);
  const split = (id: string, model: string): AgentLike => ({
    id,
    describe: () => id,
    async runTask(prompt: string) {
      bus.emit({ type: "usage", agent: id, model, inputTokens: 100, outputTokens: 20, ms: 5, turns: 1 });
      if (/A new goal has come in/.test(prompt)) {
        office.enqueue({ title: "build", details: "d", assignee: "bob" });
        return "planned";
      }
      return "ok";
    },
  });
  office.setTeam({
    manager: split("carol", "cloud:gemini"),
    workers: [split("bob", "ollama:qwen3:8b")],
  });

  office.submitGoal("ship it");
  await tick(150);

  const done = (events as GoalUpdateEvent[])
    .filter((e) => e.type === "goal_update" && (e.status === "done" || e.status === "failed"))
    .at(-1);
  assert.ok(done?.usage?.byModel, "byModel is present when >1 model contributed");
  assert.deepEqual(Object.keys(done.usage.byModel).sort(), ["cloud:gemini", "ollama:qwen3:8b"]);
  assert.equal(done.usage.byModel["ollama:qwen3:8b"].inputTokens, 100, "bob ran once");
  assert.ok(done.usage.byModel["cloud:gemini"].inputTokens >= 100, "carol's turns");
  const sum = Object.values(done.usage.byModel).reduce((s, m) => s + m.inputTokens, 0);
  assert.equal(sum, done.usage.inputTokens, "byModel sums to the total");
});

test("cost is computed per model when pricing is configured", async () => {
  const prev = config.pricing;
  config.pricing = { "cloud:fake": { in: 3, out: 15 } }; // $/1M tokens
  try {
    const { bus, events } = recordingBus();
    const office = new Office(bus, null, null);
    office.setTeam({
      manager: usageAgent("carol", bus, [{ to: "bob", title: "build" }], office),
      workers: [usageAgent("bob", bus, [], office)],
    });
    office.submitGoal("ship it");
    await tick(150);

    const done = (events as GoalUpdateEvent[])
      .filter((e) => e.type === "goal_update" && (e.status === "done" || e.status === "failed"))
      .at(-1);
    const u = done!.usage!;
    const expected = (u.inputTokens / 1e6) * 3 + (u.outputTokens / 1e6) * 15;
    assert.equal(u.costUsd, Math.round(expected * 1e6) / 1e6);
  } finally {
    config.pricing = prev;
  }
});
