import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionBroker, type PermRule } from "../src/orchestrator/permissions.ts";
import { recordingBus } from "./helpers.ts";

const req = (over: Partial<Parameters<PermissionBroker["check"]>[0]> = {}) => ({
  agent: "bob",
  tool: "run_shell",
  key: "cmd",
  detail: "some command",
  ...over,
});

const always = (d: "allow" | "deny" | "ask"): PermRule => ({ name: d, match: () => d });

test("an allow rule short-circuits without asking", async () => {
  const { bus, events } = recordingBus();
  const broker = new PermissionBroker(bus, [always("allow")]);
  const v = await broker.check(req());
  assert.equal(v.ok, true);
  assert.ok(!events.some((e) => e.type === "approval_request"));
});

test("a deny rule blocks without asking", async () => {
  const { bus, events } = recordingBus();
  const broker = new PermissionBroker(bus, [always("deny")]);
  const v = await broker.check(req());
  assert.equal(v.ok, false);
  assert.ok(!events.some((e) => e.type === "approval_request"));
});

test("an ask rule escalates and honours a human 'no'", async () => {
  const { bus, events } = recordingBus();
  const broker = new PermissionBroker(bus, [always("ask")]);
  const pending = broker.check(req({ key: "mkdir" }));
  const ask = events.find((e) => e.type === "approval_request");
  assert.ok(ask && "requestId" in ask);
  broker.resolve((ask as { requestId: string }).requestId, false);
  assert.deepEqual(await pending, { ok: false, reason: "human denied" });
});

test("no matching rule also asks", async () => {
  const { bus, events } = recordingBus();
  const broker = new PermissionBroker(bus, []);
  const pending = broker.check(req());
  const ask = events.find((e) => e.type === "approval_request") as { requestId: string };
  broker.resolve(ask.requestId, true);
  assert.equal((await pending).ok, true);
});

test("a remembered grant auto-allows the same key afterwards, for any agent", async () => {
  const { bus, events } = recordingBus();
  const broker = new PermissionBroker(bus, [always("ask")]);
  const pending = broker.check(req({ agent: "bob", key: "npm" }));
  const ask = events.find((e) => e.type === "approval_request") as { requestId: string };
  broker.resolve(ask.requestId, true, true); // remember
  await pending;

  const second = await broker.check(req({ agent: "alice", key: "npm" }));
  assert.deepEqual(second, { ok: true, reason: "session grant" });
});

test("resolving an unknown request id is a harmless no-op", () => {
  const { bus } = recordingBus();
  const broker = new PermissionBroker(bus, []);
  assert.doesNotThrow(() => broker.resolve("does-not-exist", true));
});

test("an unanswered approval auto-denies after the timeout", async () => {
  const { bus, events } = recordingBus();
  const broker = new PermissionBroker(bus, [always("ask")], 40); // 40ms
  const verdict = await broker.check(req({ key: "mkdir" }));
  assert.deepEqual(verdict, { ok: false, reason: "human denied" });
  assert.ok(events.some((e) => e.type === "log" && /auto-denied/.test(e.text)));
  assert.ok(events.some((e) => e.type === "approval_resolved" && e.approved === false));
});

test("a decision before the timeout wins and cancels it", async () => {
  const { bus, events } = recordingBus();
  const broker = new PermissionBroker(bus, [always("ask")], 5_000);
  const pending = broker.check(req({ key: "npm" }));
  const ask = events.find((e) => e.type === "approval_request") as { requestId: string };
  broker.resolve(ask.requestId, true);
  assert.deepEqual(await pending, { ok: true, reason: "human approved" });
  // only one approval_resolved (the timeout did not also fire)
  assert.equal(events.filter((e) => e.type === "approval_resolved").length, 1);
});
