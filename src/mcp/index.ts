import fs from "node:fs/promises";
import { McpClient, type McpServerConfig } from "./client.ts";
import { bridgeMcpTools } from "./tools.ts";
import type { Tool } from "../tools/index.ts";

export { McpClient } from "./client.ts";

type LogFn = (level: "info" | "warn" | "error", text: string) => void;

/**
 * Read an MCP config file (`{ "mcpServers": { name: {command,args,...} } }`,
 * the Claude-Desktop shape), start each server, and bridge its tools. A missing
 * file is fine; a server that fails to start is logged and skipped, never fatal.
 */
export async function loadMcpServers(
  configPath: string,
  log: LogFn = () => {},
): Promise<{ tools: Tool[]; clients: McpClient[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return { tools: [], clients: [] };
  }

  let servers: Record<string, McpServerConfig>;
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
    servers = parsed.mcpServers ?? {};
  } catch (err) {
    log("error", `mcp config: ${(err as Error).message}`);
    return { tools: [], clients: [] };
  }

  const tools: Tool[] = [];
  const clients: McpClient[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const client = new McpClient(name, cfg, log);
    try {
      await client.start();
      const defs = await client.listTools();
      tools.push(...bridgeMcpTools(client, defs));
      clients.push(client);
      log("info", `mcp: ${name} → ${defs.length} tool(s) [${client.trust}]`);
    } catch (err) {
      client.stop();
      log("error", `mcp: ${name} failed — ${(err as Error).message}`);
    }
  }
  return { tools, clients };
}
