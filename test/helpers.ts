import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bus } from "../src/orchestrator/bus.ts";
import type { OfficeEvent } from "../src/shared/events.ts";

/** A real Bus that also records every event, for assertions. */
export function recordingBus(): { bus: Bus; events: OfficeEvent[] } {
  const bus = new Bus();
  const events: OfficeEvent[] = [];
  bus.onEvent((e) => events.push(e));
  return { bus, events };
}

export const nullBus = { emit() {}, onEvent: () => () => {} } as unknown as Bus;

export function tmpDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `office-${name}-`));
}

export function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

export const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));
