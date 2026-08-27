import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "./index.ts";

const pexec = promisify(execFile);

/** Resolve `p` under the workspace, refusing anything that escapes it —
 *  including via a symlinked parent directory. */
async function resolveInWorkspace(workspace: string, p: unknown): Promise<string> {
  const rel = typeof p === "string" && p.length > 0 ? p : ".";
  const resolved = path.resolve(workspace, rel);
  if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) {
    throw new Error(`path escapes the workspace: ${rel}`);
  }
  if (resolved !== workspace) {
    try {
      const wsReal = await fs.realpath(workspace);
      const parentReal = await fs.realpath(path.dirname(resolved));
      if (parentReal !== wsReal && !parentReal.startsWith(wsReal + path.sep)) {
        throw new Error(`path escapes the workspace via symlink: ${rel}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return resolved;
}

/** Throw unless the agent is allowed to write to this relative path. */
function assertWritable(ctx: ToolContext, rel: unknown): void {
  const roots = ctx.writeRoots;
  if (roots.length === 0) {
    throw new Error(`${ctx.agent} has no write access`);
  }
  const norm = path.normalize(String(rel ?? "")).replace(/^(\.\/)+/, "");
  if (!roots.some((root) => norm === root.replace(/\/$/, "") || norm.startsWith(root))) {
    throw new Error(
      `${ctx.agent} may only write under: ${roots.join(", ")} (got "${rel}")`,
    );
  }
}

function clip(text: string, max = 8000): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

export const listFiles: Tool = {
  name: "list_files",
  description: "List files and folders inside a workspace directory.",
  parameters: {
    type: "object",
    properties: {
      dir: { type: "string", description: "relative path, defaults to '.'" },
    },
  },
  async run(args, ctx) {
    const dir = await resolveInWorkspace(ctx.workspace, args.dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.length === 0) return "(empty)";
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  },
};

export const readFile: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async run(args, ctx) {
    const file = await resolveInWorkspace(ctx.workspace, args.path);
    return clip(await fs.readFile(file, "utf8"));
  },
};

export const writeFile: Tool = {
  name: "write_file",
  description: "Create or overwrite a UTF-8 text file in the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    assertWritable(ctx, args.path);
    const file = await resolveInWorkspace(ctx.workspace, args.path);
    const content = String(args.content ?? "");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return `wrote ${content.length} bytes to ${args.path}`;
  },
};

export const appendFile: Tool = {
  name: "append_file",
  description:
    "Append text to the end of a workspace file, creating it if missing. Does not overwrite existing content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    assertWritable(ctx, args.path);
    const file = await resolveInWorkspace(ctx.workspace, args.path);
    let text = String(args.content ?? "");
    await fs.mkdir(path.dirname(file), { recursive: true });
    // keep a newline between the old content and the new block
    const exists = await fs
      .stat(file)
      .then((s) => s.size > 0)
      .catch(() => false);
    if (exists && !text.startsWith("\n")) text = `\n${text}`;
    await fs.appendFile(file, text, "utf8");
    return `appended ${text.length} bytes to ${args.path}`;
  },
};

export const reportProgress: Tool = {
  name: "report_progress",
  description:
    "Report how far along you are on the current task, so the office can show it.",
  parameters: {
    type: "object",
    properties: {
      progress: { type: "number", description: "0.0 to 1.0" },
      note: { type: "string", description: "one short line about what you just did" },
    },
    required: ["progress"],
  },
  async run(args, ctx) {
    const progress = Math.max(0, Math.min(1, Number(args.progress) || 0));
    const note = typeof args.note === "string" ? args.note : undefined;
    ctx.bus.emit({
      type: "agent_state",
      agent: ctx.agent,
      state: "working",
      progress,
      task: note,
    });
    return `progress noted: ${Math.round(progress * 100)}%`;
  },
};

export const runShell: Tool = {
  name: "run_shell",
  description:
    "Run a shell command in the workspace directory. Read-only commands run " +
    "immediately; anything else needs human approval.",
  parameters: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
  },
  permission(args) {
    const cmd = String(args.cmd ?? "").trim();
    return { key: cmd.split(/\s+/)[0] || "?", detail: cmd };
  },
  async run(args, ctx) {
    const cmd = String(args.cmd ?? "").trim();
    if (!cmd) return "no command given";
    try {
      const { stdout, stderr } = await pexec("/bin/zsh", ["-lc", cmd], {
        cwd: ctx.workspace,
        timeout: 60_000,
        maxBuffer: 1_000_000,
      });
      const out = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
      return clip(out.trim() || "(no output)");
    } catch (err) {
      return clip(`error: ${(err as Error).message}`, 2000);
    }
  },
};

/** Read/write file tools shared by every worker. */
export const fileTools: Tool[] = [
  listFiles,
  readFile,
  writeFile,
  appendFile,
  reportProgress,
];
