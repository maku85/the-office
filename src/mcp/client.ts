import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** "ask" (default): every call needs human approval. "allow": trusted server. */
  trust?: "ask" | "allow";
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type LogFn = (level: "info" | "warn" | "error", text: string) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT = 30_000;

/**
 * A minimal Model Context Protocol client over stdio: spawn the server, do the
 * `initialize` handshake, then `tools/list` and `tools/call`. Newline-delimited
 * JSON-RPC 2.0, one message per line.
 */
export class McpClient {
  readonly name: string;
  readonly trust: "ask" | "allow";
  private readonly cfg: McpServerConfig;
  private readonly log: LogFn;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = "";

  constructor(name: string, cfg: McpServerConfig, log: LogFn = () => {}) {
    this.name = name;
    this.cfg = cfg;
    this.trust = cfg.trust === "allow" ? "allow" : "ask";
    this.log = log;
  }

  async start(): Promise<void> {
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cfg.cwd,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (t: string) => {
      const line = t.trim();
      if (line) this.log("warn", `[mcp:${this.name}] ${line}`);
    });
    proc.on("error", (err) => this.failAll(err));
    proc.on("exit", (code) =>
      this.failAll(new Error(`mcp server "${this.name}" exited (code ${code})`)),
    );

    const init = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "the-office", version: "0.1.0" },
    })) as { protocolVersion?: string };
    if (init?.protocolVersion && init.protocolVersion !== PROTOCOL_VERSION) {
      this.log("info", `[mcp:${this.name}] server speaks ${init.protocolVersion}`);
    }
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = (await this.request("tools/list", {})) as { tools?: unknown[] };
    return (res?.tools ?? []).map((raw) => {
      const t = raw as Record<string, unknown>;
      const schema = t.inputSchema;
      return {
        name: String(t.name),
        description: String(t.description ?? ""),
        inputSchema:
          schema && typeof schema === "object"
            ? (schema as Record<string, unknown>)
            : { type: "object", properties: {} },
      };
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.request("tools/call", { name, arguments: args ?? {} })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res?.content ?? [])
      .map((p) => (p?.type === "text" ? (p.text ?? "") : JSON.stringify(p)))
      .join("\n")
      .trim();
    return res?.isError ? `error: ${text || "tool failed"}` : text || "(no output)";
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.proc = null;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log("warn", `[mcp:${this.name}] non-JSON: ${line.slice(0, 120)}`);
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        const error = msg.error as { message?: string } | undefined;
        if (error) p.reject(new Error(error.message ?? "mcp error"));
        else p.resolve(msg.result);
      }
    }
  }

  private send(obj: unknown): void {
    if (!this.proc) throw new Error(`mcp server "${this.name}" is not running`);
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp "${this.name}" ${method} timed out`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }
}
