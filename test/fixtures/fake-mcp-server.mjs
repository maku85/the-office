// Minimal stdio MCP server for tests: initialize, tools/list, tools/call.
// Newline-delimited JSON-RPC 2.0. Exposes one tool, "echo".

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      });
    case "notifications/initialized":
      return; // no response to notifications
    case "tools/list":
      return reply(msg.id, {
        tools: [
          {
            name: "echo",
            description: "echoes the given text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
    case "tools/call":
      if (msg.params?.name === "echo") {
        return reply(msg.id, {
          content: [{ type: "text", text: `echo: ${msg.params.arguments?.text}` }],
        });
      }
      return reply(msg.id, {
        content: [{ type: "text", text: `no such tool: ${msg.params?.name}` }],
        isError: true,
      });
    default:
      if (typeof msg.id === "number") {
        return replyError(msg.id, -32601, `method not found: ${msg.method}`);
      }
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
