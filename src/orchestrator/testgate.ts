/**
 * Runs the project's own test command. Shared by the `run_tests` tool and, when
 * `OFFICE_TEST_GATE` is on, the automatic post-task gate in `runOneTask`.
 *
 * It executes project code, so both callers are behind `OFFICE_ALLOW_SHELL`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "../config.ts";

const pexec = promisify(execFile);

export interface TestRun {
  ok: boolean;
  /** combined stdout+stderr (trimmed) */
  output: string;
  code: number | null;
  timedOut: boolean;
}

/** Run `config.testCmd` in `cwd`. Never throws. */
export async function execTests(cwd: string): Promise<TestRun> {
  try {
    const { stdout, stderr } = await pexec("/bin/zsh", ["-lc", config.testCmd], {
      cwd,
      timeout: config.testTimeoutMs,
      maxBuffer: 2_000_000,
    });
    return {
      ok: true,
      output: (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim(),
      code: 0,
      timedOut: false,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      code?: number | string;
    };
    const out = `${e.stdout ?? ""}${e.stderr ? `\n[stderr]\n${e.stderr}` : ""}`.trim();
    return {
      ok: false,
      output: out || e.message,
      code: typeof e.code === "number" ? e.code : null,
      timedOut: !!e.killed,
    };
  }
}

const SKIP = new Set([".git", "node_modules", ".office", "dist", "build", "out", ".next"]);
const NPM_PLACEHOLDER = /no test specified/i;

/**
 * Directories under `root` with a real test setup worth gating on — a
 * `package.json` whose `scripts.test` isn't the npm placeholder.
 */
export function findTestable(root: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const pkg = entries.find((e) => e.isFile() && e.name === "package.json");
    if (pkg) {
      try {
        const json = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        };
        const t = json?.scripts?.test;
        if (typeof t === "string" && t.trim() && !NPM_PLACEHOLDER.test(t)) found.push(dir);
      } catch {
        /* unparseable package.json — the lint gate reports that */
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}
