import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Bus } from "../src/orchestrator/bus.ts";
import type { OfficeEvent } from "../src/shared/events.ts";

/** A Bus stand-in that records everything emitted. */
export function recordingBus(): { bus: Bus; events: OfficeEvent[] } {
  const events: OfficeEvent[] = [];
  const bus = { emit: (e: OfficeEvent) => events.push(e) } as unknown as Bus;
  return { bus, events };
}

export const nullBus = { emit() {} } as unknown as Bus;

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
