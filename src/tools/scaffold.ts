import path from "node:path";
import fs from "node:fs/promises";
import { slugify } from "../orchestrator/vcs.ts";
import type { Tool } from "./index.ts";

/** Skeletons are wiring only — a working shell with TODOs, never the solution. */
const KINDS = ["canvas-game", "webapp", "node-lib", "docs", "static"] as const;
type Kind = (typeof KINDS)[number];

function files(kind: Kind, name: string): Record<string, string> {
  switch (kind) {
    case "canvas-game":
      return {
        "index.html": `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${name}</title>
<style>html,body{margin:0;height:100%;background:#111}canvas{display:block;margin:0 auto;background:#000}</style>
</head>
<body>
<canvas id="game" width="480" height="480"></canvas>
<script>
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// TODO: game state

addEventListener("keydown", (e) => {
  // TODO: react to e.key — "ArrowUp" / "ArrowDown" / "ArrowLeft" / "ArrowRight"
});

let last = 0;
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  // TODO: update(dt)
  // TODO: draw()
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
</script>
</body>
</html>
`,
      };
    case "webapp":
    case "static":
      return {
        "index.html": `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${name}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; line-height: 1.5; }
</style>
</head>
<body>
<h1>${name}</h1>
<div id="app"><!-- TODO: build the UI here --></div>
<script>
// TODO: app logic
</script>
</body>
</html>
`,
      };
    case "node-lib":
      return {
        "package.json":
          JSON.stringify(
            {
              name: slugify(name),
              version: "0.1.0",
              type: "module",
              scripts: { test: "node --test" },
            },
            null,
            2,
          ) + "\n",
        "index.js": `// TODO: export the library's real API.
export function todo() {
  throw new Error("not implemented");
}
`,
        "test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { todo } from "./index.js";

test("placeholder — replace with real tests", () => {
  assert.equal(typeof todo, "function");
});
`,
      };
    case "docs":
      return { "README.md": `# ${name}\n\n> TODO: what it is, who it's for, how to use it.\n` };
  }
}

const ENTRY: Record<Kind, string> = {
  "canvas-game": "index.html",
  webapp: "index.html",
  static: "index.html",
  "node-lib": "index.js",
  docs: "README.md",
};

/**
 * Deterministic project scaffold for the manager to call once in planning: it
 * slugifies the name a single time (so every task uses the same folder) and
 * drops a minimal working skeleton for `kind`. Confined to `projects/<slug>/`
 * regardless of writeRoots — the paths and content are fixed by this tool, not
 * the agent — and it never overwrites a file that already exists.
 */
export function makeCreateProject(): Tool {
  return {
    name: "create_project",
    description:
      "Scaffold projects/<slug>/ with a minimal skeleton and return the canonical " +
      "path. Call ONCE at the start of planning so every task targets the same folder. " +
      `kind: ${KINDS.join(" | ")}.`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "human name of the project" },
        kind: { type: "string", enum: [...KINDS] },
      },
      required: ["name"],
    },
    async run(args, ctx) {
      const name = String(args.name ?? "").trim();
      if (!name) return "create_project: a name is required";
      const kind = (KINDS as readonly string[]).includes(String(args.kind))
        ? (args.kind as Kind)
        : "webapp";
      const slug = slugify(name);
      const dirRel = `projects/${slug}`;
      const dirAbs = path.resolve(ctx.workspace, dirRel);
      if (dirAbs !== path.join(ctx.workspace, "projects", slug)) {
        return `create_project: refusing unexpected path for "${name}"`;
      }

      await fs.mkdir(dirAbs, { recursive: true });
      const written: string[] = [];
      const skipped: string[] = [];
      for (const [rel, body] of Object.entries(files(kind, name))) {
        const abs = path.join(dirAbs, rel);
        try {
          await fs.writeFile(abs, body, { flag: "wx" }); // wx: fail if it exists
          written.push(rel);
        } catch {
          skipped.push(rel);
        }
      }
      const parts = [`project ready at ${dirRel}/ (${kind}); entry: ${dirRel}/${ENTRY[kind]}`];
      if (written.length) parts.push(`created: ${written.join(", ")}`);
      if (skipped.length) parts.push(`kept existing: ${skipped.join(", ")}`);
      return parts.join("\n");
    },
  };
}
