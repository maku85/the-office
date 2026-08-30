import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { smokeHtml, smokeProject, formatSmoke } from "../src/orchestrator/smoke.ts";

function tmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

const page = (body: string, script: string) =>
  `<!doctype html><html><body>${body}<script>${script}</script></body></html>`;

test("a clean canvas page loads with no errors", () => {
  const dir = tmp({
    "index.html": page(
      `<canvas id="c" width="200" height="200"></canvas><span id="score">0</span>`,
      `const cv = document.getElementById("c");
       const ctx = cv.getContext("2d");
       let dir = { x: 1, y: 0 };
       document.addEventListener("keydown", (e) => { if (e.key === "ArrowUp") dir = { x: 0, y: -1 }; });
       function tick() { ctx.fillRect(0, 0, 10, 10); document.getElementById("score").textContent = "1"; }
       window.onload = () => setInterval(tick, 100);`,
    ),
  });
  const r = smokeHtml(path.join(dir, "index.html"), { canvas: true });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(r.errors, []);
});

test("an undefined reference thrown from a timer is caught", () => {
  const dir = tmp({
    "index.html": page(
      `<span id="score">0</span>`,
      `function move() { scoreEl.textContent = "1"; }   // scoreEl never declared
       window.onload = () => setInterval(move, 50);`,
    ),
  });
  const r = smokeHtml(path.join(dir, "index.html"));
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /scoreEl is not defined/);
});

test("dereferencing a missing element is caught", () => {
  const dir = tmp({
    "index.html": page("", `document.getElementById("nope").style.display = "block";`),
  });
  const r = smokeHtml(path.join(dir, "index.html"));
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /Cannot (read|set).*(null|properties)/i);
});

test("a missing local <script src> is an error", () => {
  const dir = tmp({
    "index.html": `<!doctype html><html><body><script src="game.js"></script></body></html>`,
  });
  const r = smokeHtml(path.join(dir, "index.html"));
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /missing script file: game\.js/);
});

test("a syntax error in the script is an error", () => {
  const dir = tmp({ "index.html": page("", `function () { return ;;; }}}`) });
  const r = smokeHtml(path.join(dir, "index.html"));
  assert.equal(r.ok, false);
});

test("wired keyboard input clears the 'dead controls' warning", () => {
  const withKeys = tmp({
    "index.html": page("", `window.addEventListener("keydown", () => {});`),
  });
  const r = smokeHtml(path.join(withKeys, "index.html"));
  assert.equal(r.ok, true);
  assert.ok(!r.warnings.some((w) => /controls/.test(w)));
});

test("smokeProject only checks files touched since the cutoff", () => {
  const dir = tmp({
    "projects/a/index.html": page("", `throw new Error("boom");`),
    "projects/b/old.html": page("", `throw new Error("stale");`),
  });
  const old = path.join(dir, "projects/b/old.html");
  const past = Date.now() - 60_000;
  fs.utimesSync(old, past / 1000, past / 1000);

  const results = smokeProject(dir, Date.now() - 10_000);
  assert.equal(results.length, 1, "the stale file is skipped");
  assert.match(results[0].file, /projects\/a\/index\.html$/);
  assert.equal(results[0].ok, false);
  assert.match(formatSmoke(results), /throws on load/);
});
