import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.ts";
import type { Bus } from "./bus.ts";

const pexec = promisify(execFile);

/* ---------- parsers (pure, unit-tested) ---------- */

export interface CpuSample {
  idle: number;
  total: number;
}

export function cpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

export function cpuPercent(a: CpuSample, b: CpuSample): number {
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
}

/** macOS `vm_stat` → used memory (active + wired + compressed), like Activity Monitor. */
export function parseVmStat(stdout: string, totalBytes: number): { usedMB: number; totalMB: number } {
  const totalMB = Math.round(totalBytes / 1e6);
  const pageSize = Number(/page size of (\d+)/.exec(stdout)?.[1] ?? 4096);
  const pages = (label: string) =>
    Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
  const used =
    pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor");
  if (!used) return { usedMB: totalMB, totalMB };
  return { usedMB: Math.round((used * pageSize) / 1e6), totalMB };
}

/** `sysctl -n vm.swapusage` → "total = 2048.00M  used = 512.25M  free = ..." */
export function parseSwap(stdout: string): { usedMB: number; totalMB: number } | null {
  const total = /total = ([\d.]+)M/.exec(stdout)?.[1];
  const used = /used = ([\d.]+)M/.exec(stdout)?.[1];
  if (!total || !used) return null;
  return { usedMB: Math.round(+used), totalMB: Math.round(+total) };
}

/* ---------- collectors (best-effort, never throw) ---------- */

async function readMem(): Promise<{ usedMB: number; totalMB: number }> {
  try {
    const { stdout } = await pexec("vm_stat", [], { timeout: 3000 });
    return parseVmStat(stdout, os.totalmem());
  } catch {
    return {
      usedMB: Math.round((os.totalmem() - os.freemem()) / 1e6),
      totalMB: Math.round(os.totalmem() / 1e6),
    };
  }
}

async function readSwap(): Promise<{ usedMB: number; totalMB: number } | null> {
  try {
    const { stdout } = await pexec("sysctl", ["-n", "vm.swapusage"], { timeout: 3000 });
    return parseSwap(stdout);
  } catch {
    return null;
  }
}

async function readTemp(): Promise<number | null> {
  // macOS has no no-sudo API; `osx-cpu-temp` (brew) works on Intel, usually not on Apple Silicon.
  try {
    const { stdout } = await pexec("osx-cpu-temp", [], { timeout: 2000 });
    const n = Number(/([\d.]+)/.exec(stdout)?.[1]);
    return Number.isFinite(n) && n > 1 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

async function readOllamaModels(): Promise<Array<{ name: string; sizeMB: number; vramMB: number }>> {
  try {
    const res = await fetch(`${config.ollamaHost}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      models?: Array<{ name: string; size: number; size_vram?: number }>;
    };
    return (json.models ?? []).map((m) => ({
      name: m.name,
      sizeMB: Math.round(m.size / 1e6),
      vramMB: Math.round((m.size_vram ?? 0) / 1e6),
    }));
  } catch {
    return [];
  }
}

/* ---------- monitor ---------- */

/** Poll machine + Ollama state and emit a `system` event. Returns a stop fn. */
export function startSystemMonitor(bus: Bus, intervalMs = config.systemPollMs): () => void {
  if (intervalMs <= 0) return () => {};
  let last = cpuSample();

  const tick = async () => {
    const now = cpuSample();
    const cpu = cpuPercent(last, now);
    last = now;

    const [mem, swap, tempC, models] = await Promise.all([
      readMem(),
      readSwap(),
      readTemp(),
      readOllamaModels(),
    ]);

    bus.emit({
      type: "system",
      cpu,
      cores: os.cpus().length,
      load: os.loadavg().map((n) => +n.toFixed(2)) as [number, number, number],
      memUsedMB: mem.usedMB,
      memTotalMB: mem.totalMB,
      procRssMB: Math.round(process.memoryUsage.rss() / 1e6),
      swapUsedMB: swap?.usedMB ?? null,
      swapTotalMB: swap?.totalMB ?? null,
      tempC,
      models,
      platform: `${os.platform()} ${os.arch()}`,
      uptimeS: Math.round(os.uptime()),
    });
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
