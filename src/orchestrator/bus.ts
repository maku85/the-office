import { EventEmitter } from "node:events";
import type { OfficeEvent } from "../shared/events.ts";

/**
 * The office event bus. Everything the agents do flows through here as
 * {@link OfficeEvent}s; the web server subscribes and fans them out to UIs.
 * Human approvals live in the {@link PermissionBroker}, not here.
 */
export class Bus {
  private ee = new EventEmitter({ captureRejections: true });
  private ring: OfficeEvent[] = [];

  emit(event: OfficeEvent): void {
    this.ring.push(event);
    if (this.ring.length > 500) this.ring.shift();
    this.ee.emit("event", event);
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  onEvent(listener: (event: OfficeEvent) => void): () => void {
    this.ee.on("event", listener);
    return () => this.ee.off("event", listener);
  }

  /** Recent history, for a client that just connected. */
  recent(): OfficeEvent[] {
    return [...this.ring];
  }
}
