import type { Tool } from "../tools/index.ts";
import type { McpClient, McpToolDef } from "./client.ts";

/**
 * Expose an MCP server's tools as office {@link Tool}s. Names are namespaced
 * (`server__tool`) to avoid clashes with built-ins and other servers. Unless the
 * server is configured `trust: "allow"`, every call is routed through the
 * permission broker.
 */
export function bridgeMcpTools(client: McpClient, defs: McpToolDef[]): Tool[] {
  return defs.map((def) => {
    const tool: Tool = {
      name: `${client.name}__${def.name}`,
      description: def.description || `${def.name} (via ${client.name})`,
      parameters: def.inputSchema,
      run: (args) => client.callTool(def.name, args ?? {}),
    };
    if (client.trust !== "allow") {
      tool.permission = (args) => ({
        key: client.name,
        detail: `${client.name}: ${def.name}(${JSON.stringify(args).slice(0, 140)})`,
      });
    }
    return tool;
  });
}
