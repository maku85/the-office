import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpuPercent,
  parseVmStat,
  parseSwap,
  startSystemMonitor,
} from "../src/orchestrator/system.ts";
import { recordingBus } from "./helpers.ts";

test("cpuPercent from two idle/total samples", () => {
  assert.equal(cpuPercent({ idle: 0, total: 0 }, { idle: 80, total: 100 }), 20);
  assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 200, total: 400 }), 50);
  assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 100, total: 400 }), 100); // idle flat
  assert.equal(cpuPercent({ idle: 5, total: 5 }, { idle: 5, total: 5 }), 0); // no delta
});

test("parseVmStat sums active + wired + compressed pages", () => {
  const out = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                          10000.
Pages active:                        60000.
Pages inactive:                      20000.
Pages wired down:                    30000.
Pages occupied by compressor:        10000.`;
  const total = 18 * 1024 ** 3; // 18 GiB
  const { usedMB, totalMB } = parseVmStat(out, total);
  // (60000 + 30000 + 10000) pages * 16384 bytes = 1.6384e9 bytes
  assert.equal(usedMB, Math.round((100000 * 16384) / 1e6));
  assert.equal(totalMB, Math.round(total / 1e6));
});

test("parseSwap reads total and used", () => {
  assert.deepEqual(parseSwap("total = 2048.00M  used = 512.25M  free = 1535.75M  (encrypted)"), {
    usedMB: 512,
    totalMB: 2048,
  });
  assert.equal(parseSwap("nonsense"), null);
});

test("the monitor emits a system event with real machine numbers", async () => {
  const { bus, events } = recordingBus();
  const stop = startSystemMonitor(bus, 20);
  await new Promise((r) => setTimeout(r, 120));
  stop();

  const s = events.find((e) => e.type === "system") as
    | import("../src/shared/events.ts").SystemStatsEvent
    | undefined;
  assert.ok(s, "a system event was emitted");
  assert.equal(typeof s!.cpu, "number");
  assert.ok(s!.memTotalMB > 0);
  assert.ok(s!.cores > 0);
  assert.equal(s!.load.length, 3);
});

test("interval 0 disables the monitor", () => {
  const { bus, events } = recordingBus();
  const stop = startSystemMonitor(bus, 0);
  stop();
  assert.ok(!events.some((e) => e.type === "system"));
});
