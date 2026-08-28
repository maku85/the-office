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
  private lastSystem: OfficeEvent | null = null;

  emit(event: OfficeEvent): void {
    // high-frequency machine stats stay out of the history ring — keep only the latest
    if (event.type === "system") {
      this.lastSystem = event;
    } else {
      this.ring.push(event);
      if (this.ring.length > 500) this.ring.shift();
    }
    this.ee.emit("event", event);
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  onEvent(listener: (event: OfficeEvent) => void): () => void {
    this.ee.on("event", listener);
    return () => this.ee.off("event", listener);
  }

  /** Recent history, for a client that just connected. */
  recent(): OfficeEvent[] {
    return this.lastSystem ? [...this.ring, this.lastSystem] : [...this.ring];
  }
}
