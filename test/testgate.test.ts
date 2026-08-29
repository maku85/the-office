import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execTests, findTestable } from "../src/orchestrator/testgate.ts";
import { config } from "../src/config.ts";
import { tmpDir } from "./helpers.ts";

async function withFiles(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir("testgate");
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return dir;
}

test("findTestable spots a package.json with a real test script", async () => {
  const dir = await withFiles({
    "projects/app/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "projects/lib/package.json": JSON.stringify({ scripts: { build: "tsc" } }), // no test
    "projects/stub/package.json": JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' }, // npm placeholder
    }),
    "projects/app/node_modules/dep/package.json": JSON.stringify({ scripts: { test: "x" } }), // skipped
  });
  const found = findTestable(dir).map((d) => path.relative(dir, d));
  assert.deepEqual(found, ["projects/app"]);
});

test("execTests reports a passing command", async () => {
  const prev = config.testCmd;
  config.testCmd = "echo GREEN";
  try {
    const dir = await withFiles({ "x.txt": "" });
    const r = await execTests(dir);
    assert.equal(r.ok, true);
    assert.match(r.output, /GREEN/);
  } finally {
    config.testCmd = prev;
  }
});

test("execTests captures a failing command without throwing", async () => {
  const prev = config.testCmd;
  config.testCmd = "echo BOOM >&2; exit 3";
  try {
    const dir = await withFiles({ "x.txt": "" });
    const r = await execTests(dir);
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    assert.match(r.output, /BOOM/);
  } finally {
    config.testCmd = prev;
  }
});
