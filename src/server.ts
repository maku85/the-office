import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Bus } from "./orchestrator/bus.ts";
import type { PermissionBroker } from "./orchestrator/permissions.ts";
import type { ClientMessage } from "./shared/events.ts";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Serves the static office UI and bridges the {@link Bus} to every connected
 * browser over WebSocket. Browser → server messages are approvals and
 * free-text commands.
 */
export function startServer(
  port: number,
  bus: Bus,
  broker: PermissionBroker,
  onCommand: (text: string) => void,
  onUndo: (goalId: string) => void,
): http.Server {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    const rel = urlPath === "/" ? "/index.html" : urlPath;
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));

    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "snapshot", events: bus.recent() }));

    const unsubscribe = bus.onEvent((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });
    ws.on("close", unsubscribe);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "approval_decision") {
        broker.resolve(msg.requestId, msg.approved, msg.remember ?? false);
      } else if (msg.type === "command" && msg.text.trim()) {
        onCommand(msg.text.trim());
      } else if (msg.type === "undo_goal" && msg.goalId) {
        onUndo(msg.goalId);
      }
    });
  });

  server.listen(port, () => {
    console.log(`the office → http://localhost:${port}`);
  });
  return server;
}
