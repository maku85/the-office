import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { Bus } from "./orchestrator/bus.ts";
import { Office } from "./orchestrator/office.ts";
import { Memory } from "./orchestrator/memory.ts";
import { Vcs } from "./orchestrator/vcs.ts";
import { PermissionBroker } from "./orchestrator/permissions.ts";
import { defaultRules } from "./orchestrator/rules.ts";
import { buildProviders } from "./llm/index.ts";
import { loadMcpServers } from "./mcp/index.ts";
import { Agent } from "./agents/agent.ts";
import {
  MANAGER_SYSTEM,
  DEVELOPER_SYSTEM,
  RESEARCHER_SYSTEM,
} from "./agents/prompts.ts";
import { fileTools, runShell } from "./tools/filesystem.ts";
import { makeAssignTask } from "./tools/assign.ts";
import { makeMemoryTools } from "./tools/memory.ts";
import { startServer } from "./server.ts";

async function main(): Promise<void> {
  await fs.mkdir(path.join(config.workspace, "projects", "demo"), { recursive: true });

  const bus = new Bus();
  const broker = new PermissionBroker(bus, defaultRules);
  const memory = new Memory(config.memoryDb, bus);
  const vcs = await Vcs.create(config.workspace, bus, config.git);
  const office = new Office(bus, memory, vcs);
  const memoryTools = makeMemoryTools(memory);
  const { worker, manager } = buildProviders();
  console.log(`models → workers: ${worker.label}   manager: ${manager.label}`);

  const mcp = await loadMcpServers(config.mcpConfig, (level, text) =>
    bus.emit({ type: "log", level, text }),
  );
  if (mcp.tools.length) {
    console.log(`mcp → ${mcp.tools.length} tool(s) from ${mcp.clients.length} server(s)`);
  }

  const common = { bus, broker, workspace: config.workspace };
  const shellTools = config.allowShell ? [runShell] : [];
  console.log(`run_shell: ${config.allowShell ? "ENABLED" : "disabled (set OFFICE_ALLOW_SHELL=1)"}`);

  const bob = new Agent({
    ...common,
    provider: worker,
    id: "bob",
    role: "developer",
    blurb: config.allowShell
      ? "writes code and files, runs shell commands (with approval)"
      : "writes code and files (no shell access in this run)",
    desk: "desk_dev",
    systemPrompt: DEVELOPER_SYSTEM,
    tools: [...fileTools, ...shellTools, ...memoryTools, ...mcp.tools],
    writeRoots: ["projects/", "shared/"],
  });

  const alice = new Agent({
    ...common,
    provider: worker,
    id: "alice",
    role: "researcher",
    blurb: "gathers information and writes Markdown notes; no shell access",
    desk: "desk_research",
    systemPrompt: RESEARCHER_SYSTEM,
    tools: [...fileTools, ...memoryTools, ...mcp.tools],
    writeRoots: ["projects/", "shared/"],
  });

  const carol = new Agent({
    ...common,
    provider: manager,
    id: "carol",
    role: "manager",
    blurb: "plans and delegates; does no hands-on work",
    desk: "desk_manager",
    systemPrompt: MANAGER_SYSTEM,
    tools: [makeAssignTask(office), ...memoryTools],
    writeRoots: [], // read-only: the manager never touches files
  });

  office.setTeam({ manager: carol, workers: [bob, alice] });
  for (const agent of [carol, alice, bob]) agent.register();
  memory.replayBlackboard();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      memory.close();
      mcp.clients.forEach((c) => c.stop());
      process.exit(0);
    });
  }

  startServer(
    config.port,
    bus,
    broker,
    (text) => office.submitGoal(text),
    (goalId) => void office.undoGoal(goalId),
  );

  if (!config.noAutoTask) {
    setTimeout(() => {
      office.submitGoal(
        "Produce projects/demo/overview.md: a concise overview of what this local " +
          "AI office project is for and how it is structured.",
      );
    }, 1500);
  }
}

void main();
