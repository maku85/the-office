import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { Bus } from "./orchestrator/bus.ts";
import { Office } from "./orchestrator/office.ts";
import { Memory } from "./orchestrator/memory.ts";
import { Vcs } from "./orchestrator/vcs.ts";
import { PermissionBroker } from "./orchestrator/permissions.ts";
import { defaultRules } from "./orchestrator/rules.ts";
import { buildProviders, type Provider } from "./llm/index.ts";
import { loadMcpServers } from "./mcp/index.ts";
import { Agent } from "./agents/agent.ts";
import { ROLES } from "./agents/roles.ts";
import { toolsetFor, type ToolsetDeps } from "./tools/toolsets.ts";
import { makeAssignTask } from "./tools/assign.ts";
import { makeMemoryTools } from "./tools/memory.ts";
import { makeHireAgent, makeHireTeam, makeDismissAgent } from "./tools/hiring.ts";
import { makeReviewTool } from "./tools/review.ts";
import { makeAskManager } from "./tools/ask.ts";
import { makeUseSkill } from "./tools/skill.ts";
import { loadSkills } from "./skills/index.ts";
import { startSystemMonitor } from "./orchestrator/system.ts";
import { startServer } from "./server.ts";

async function main(): Promise<void> {
  await fs.mkdir(path.join(config.workspace, "projects", "demo"), { recursive: true });

  const bus = new Bus();
  const broker = new PermissionBroker(bus, defaultRules);
  const memory = new Memory(config.memoryDb, bus);
  const vcs = await Vcs.create(config.workspace, bus, config.git);
  const skills = await loadSkills(config.skillsDirs, (level, text) =>
    bus.emit({ type: "log", level, text }),
  );
  if (skills.all.length) console.log(`skills → ${skills.all.map((s) => s.name).join(", ")}`);
  const office = new Office(bus, memory, vcs, skills);
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
  console.log(`run_shell: ${config.allowShell ? "ENABLED" : "disabled (set OFFICE_ALLOW_SHELL=1)"}`);

  const managerDeps: ToolsetDeps = {
    memoryTools,
    mcpTools: mcp.tools,
    assignTask: makeAssignTask(office),
    hireTeam: makeHireTeam(office),
    hireAgent: makeHireAgent(office),
    dismissAgent: makeDismissAgent(office),
  };
  const workerDeps: ToolsetDeps = {
    memoryTools,
    mcpTools: mcp.tools,
    reviewTool: makeReviewTool(office),
    askManager: makeAskManager(office),
    useSkill: skills.all.length ? makeUseSkill(skills) : undefined,
  };

  /** Build an agent from a role in the catalogue, folding in its default skills. */
  function buildAgent(
    id: string,
    roleKey: string,
    desk: string,
    provider: Provider,
    focus?: string,
  ): Agent {
    const r = ROLES[roleKey];
    const isManager = r.toolset === "manager";
    const parts = [r.systemPrompt];
    const roleSkills = skills.resolve(r.skills);
    if (roleSkills) parts.push(roleSkills);
    const idx = skills.index(isManager ? undefined : [roleKey]);
    if (idx) {
      parts.push(
        isManager
          ? `Skills the team can load (tag a task with "skills: [...]"):\n${idx}`
          : `Skills you can load with use_skill:\n${idx}`,
      );
    }
    if (focus) parts.push(`Focus for this hire: ${focus}`);
    return new Agent({
      ...common,
      provider,
      id,
      role: r.role,
      blurb: focus ? `${r.blurb} — ${focus}` : r.blurb,
      desk,
      systemPrompt: parts.join("\n\n"),
      tools: toolsetFor(r.toolset, isManager ? managerDeps : workerDeps),
      writeRoots: r.writeRoots,
    });
  }

  office.enableHiring((opts) =>
    buildAgent(opts.id, opts.roleKey, opts.desk, worker, opts.focus),
  );

  const carol = buildAgent("carol", "manager", "desk_manager", manager);
  // The office starts with just the manager; she hires per goal.
  const seed = config.seedTeam
    ? [
        buildAgent("bob", "developer", "desk_dev", worker),
        buildAgent("alice", "researcher", "desk_research", worker),
      ]
    : [];

  office.setTeam({ manager: carol, workers: seed });
  for (const agent of [carol, ...seed]) agent.register();
  console.log(`team: carol + ${seed.length ? seed.map((a) => a.id).join(", ") : "(hires per goal)"}`);
  memory.replayBlackboard();

  const stopSystemMonitor = startSystemMonitor(bus);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopSystemMonitor();
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

  if (config.autoTask) {
    setTimeout(() => {
      office.submitGoal(
        "Produce projects/demo/overview.md: a concise overview of what this local " +
          "AI office project is for and how it is structured.",
      );
    }, 1500);
  }
}

void main();
