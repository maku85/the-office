/**
 * A dependency-free "does it even parse" gate for the non-HTML code a task
 * produced. Pure syntax checking — never executes anything:
 *   - `.js` / `.mjs` / `.cjs`  →  `node --check` (built in; parse only)
 *   - `.json`                  →  `JSON.parse`
 *
 * The smoke gate (`smoke.ts`) covers HTML; this covers the script and data
 * files it can't. A file that doesn't parse is rework, same as a broken page.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LintResult {
  file: string;
  ok: boolean;
  errors: string[];
}

const JS_RE = /\.(?:js|mjs|cjs)$/i;
const JSON_RE = /\.json$/i;
const PY_RE = /\.py$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".office", "dist", "build", "out", ".next", "__pycache__"]);

/** `python3` on PATH? Probed once — the `.py` check is skipped if absent. */
let python3: string | null | undefined;
function hasPython(): string | null {
  if (python3 === undefined) {
    try {
      execFileSync("python3", ["--version"], { stdio: "ignore", timeout: 3000 });
      python3 = "python3";
    } catch {
      python3 = null;
    }
  }
  return python3;
}

function checkPy(abs: string): string[] {
  const py = hasPython();
  if (!py) return [];
  try {
    execFileSync(py, ["-m", "py_compile", abs], { stdio: "pipe", timeout: 8000 });
    return [];
  } catch (err) {
    const raw = errText(err);
    const m = raw.match(/SyntaxError:[^\n]*|IndentationError:[^\n]*/);
    return [m ? m[0].trim() : raw.split("\n").slice(-3).join(" ").trim()];
  }
}

/** `node --check` output when the file is fine to parse but uses ESM in a `.js`
 *  — we can't know the project's module mode from here, so we don't flag it. */
const MODULE_MODE_NOISE =
  /import statement outside a module|export .* outside a module|'import' and 'export' .* may only appear/i;

function errText(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const s = e.stderr ? e.stderr.toString() : "";
  return (s || e.message || String(err)).trim();
}

function checkJs(abs: string): string[] {
  try {
    execFileSync(process.execPath, ["--check", abs], { stdio: "pipe", timeout: 5000 });
    return [];
  } catch (err) {
    const raw = errText(err);
    if (MODULE_MODE_NOISE.test(raw)) return [];
    const m = raw.match(/SyntaxError:[^\n]*/);
    return [m ? m[0].trim() : raw.split("\n").slice(0, 3).join(" ").trim()];
  }
}

function checkJson(abs: string): string[] {
  try {
    JSON.parse(fs.readFileSync(abs, "utf8"));
    return [];
  } catch (err) {
    return [`invalid JSON: ${(err as Error).message}`];
  }
}

/** Syntax-check every JS / JSON file under `root` touched at or after `sinceMs`. */
export function lintProject(root: string, sinceMs = 0): LintResult[] {
  const out: LintResult[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const check = JS_RE.test(e.name)
        ? checkJs
        : JSON_RE.test(e.name)
          ? checkJson
          : PY_RE.test(e.name)
            ? checkPy
            : null;
      if (!check) continue;
      try {
        if (fs.statSync(p).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      const errors = check(p);
      out.push({ file: p, ok: errors.length === 0, errors });
    }
  };
  walk(root);
  return out;
}

/** A short, reviewer-readable report of the parse failures. */
export function formatLint(results: LintResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    if (r.ok) continue;
    const name = r.file.split("/").slice(-2).join("/");
    lines.push(`✗ ${name} — does not parse:`);
    for (const e of r.errors) lines.push(`   • ${e}`);
  }
  return lines.join("\n");
}
