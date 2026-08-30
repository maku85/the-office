import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "../src/mcp/client.ts";
import { bridgeMcpTools } from "../src/mcp/tools.ts";
import { loadMcpServers } from "../src/mcp/index.ts";
import type { ToolContext } from "../src/tools/index.ts";
import { tmpDir } from "./helpers.ts";

const FAKE_SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-mcp-server.mjs",
);
const asServer = (over: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [FAKE_SERVER],
  ...over,
});

test("client: handshake, list tools, call, error, stop", async () => {
  const client = new McpClient("fake", asServer());
  await client.start();

  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["echo"],
  );
  assert.equal(tools[0].inputSchema.type, "object");

  assert.equal(await client.callTool("echo", { text: "hi" }), "echo: hi");
  assert.match(await client.callTool("missing", {}), /^error:/);

  client.stop();
});

test("bridge: namespaces names and gates ask-trust servers", async () => {
  const client = new McpClient("fs", asServer());
  await client.start();
  const [tool] = bridgeMcpTools(client, await client.listTools());

  assert.equal(tool.name, "fs__echo");
  assert.ok(tool.permission, "ask-trust server attaches a permission gate");
  assert.equal(tool.permission!({ text: "x" }).key, "fs");
  assert.equal(await tool.run({ text: "x" }, {} as ToolContext), "echo: x");

  client.stop();
});

test("bridge: trust:allow skips the permission gate", async () => {
  const client = new McpClient("fetch", asServer({ trust: "allow" }));
  await client.start();
  const [tool] = bridgeMcpTools(client, await client.listTools());
  assert.equal(tool.permission, undefined);
  client.stop();
});

test("loader: a missing config file is not an error", async () => {
  assert.deepEqual(await loadMcpServers("/no/such/mcp.json"), { tools: [], clients: [] });
});

test("loader: reads a config and bridges its servers", async () => {
  const cfg = path.join(await tmpDir("mcp"), "mcp.json");
  await fs.writeFile(cfg, JSON.stringify({ mcpServers: { fake: asServer({ trust: "allow" }) } }));
  const { tools, clients } = await loadMcpServers(cfg);
  assert.deepEqual(
    tools.map((t) => t.name),
    ["fake__echo"],
  );
  clients.forEach((c) => c.stop());
});

test("loader: a server that fails to start is skipped, not fatal", async () => {
  const cfg = path.join(await tmpDir("mcp"), "mcp.json");
  await fs.writeFile(
    cfg,
    JSON.stringify({ mcpServers: { broken: { command: "definitely-not-a-real-binary-xyz" } } }),
  );
  const logs: string[] = [];
  const { tools } = await loadMcpServers(cfg, (l, t) => logs.push(`${l}:${t}`));
  assert.equal(tools.length, 0);
  assert.ok(logs.some((l) => /broken failed/.test(l)));
});
