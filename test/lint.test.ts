import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { lintProject, formatLint } from "../src/orchestrator/lint.ts";
import { tmpDir } from "./helpers.ts";

const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function withFiles(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("lint");
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return dir;
}

test("clean JS and JSON pass", async () => {
  const dir = await withFiles({
    "app.js": "const x = 1;\nfunction f() { return x + 1; }\nf();\n",
    "data.json": '{ "ok": true, "n": 3 }',
    "readme.md": "not checked",
  });
  const results = lintProject(dir);
  assert.ok(
    results.every((r) => r.ok),
    formatLint(results),
  );
  assert.equal(results.length, 2); // md is ignored
});

test("a JS syntax error is caught", async () => {
  const dir = await withFiles({ "broken.js": "function oops( { return 1 }\n" });
  const [r] = lintProject(dir);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /SyntaxError/);
});

test("malformed JSON is caught", async () => {
  const dir = await withFiles({ "bad.json": "{ nope: }" });
  const [r] = lintProject(dir);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /invalid JSON/);
});

test("ESM syntax is not a false positive (.mjs and module-mode .js)", async () => {
  const dir = await withFiles({
    "mod.mjs": "export const a = 1;\nimport { readFile } from 'node:fs';\nreadFile;\n",
    "esm.js": "export function hi() { return 42; }\n",
  });
  const results = lintProject(dir);
  assert.ok(
    results.every((r) => r.ok),
    formatLint(results),
  );
});

test("only files touched since `sinceMs` are checked", async () => {
  const dir = await withFiles({ "old.js": "const bad = (" });
  const future = Date.now() + 60_000;
  assert.deepEqual(lintProject(dir, future), []);
  assert.equal(lintProject(dir, 0).length, 1);
});

test("node_modules and dist are skipped", async () => {
  const dir = await withFiles({
    "node_modules/pkg/index.js": "syntax ( error",
    "dist/bundle.js": "also ( broken",
    "src/main.js": "const ok = 1; ok;\n",
  });
  const results = lintProject(dir);
  assert.equal(results.length, 1);
  assert.ok(results[0].ok);
});

test("a Python syntax error is caught (when python3 is available)", {
  skip: !hasPython,
}, async () => {
  const dir = await withFiles({ "bad.py": "def f(:\n  return 1\n" });
  const [r] = lintProject(dir);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /SyntaxError|IndentationError/);
});

test("clean Python passes (when python3 is available)", { skip: !hasPython }, async () => {
  const dir = await withFiles({ "ok.py": "def f(x):\n    return x + 1\n" });
  assert.ok(lintProject(dir).every((r) => r.ok));
});

test("formatLint lists only the failures", async () => {
  const dir = await withFiles({
    "good.js": "const a = 1; a;\n",
    "bad.js": "const b = (",
  });
  const report = formatLint(lintProject(dir));
  assert.match(report, /bad\.js — does not parse/);
  assert.doesNotMatch(report, /good\.js/);
});
