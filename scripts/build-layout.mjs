#!/usr/bin/env node
/*
 * Bridge between a Tiled map and the renderer's floor plan.
 *
 *   node scripts/build-layout.mjs init   public/office.layout.js  -> public/office.tiled.json (+ palette PNG)
 *   node scripts/build-layout.mjs        public/office.tiled.json -> public/office.layout.js  (after editing in Tiled)
 *
 * Zero dependencies. Tiled export: JSON, orthogonal, 16px tiles, tileset
 * *embedded*. One tile layer named "structure" painted with the 5-swatch
 * palette (floor / wall / meeting-wall / carpet / door, in that order), and one
 * object layer. See public/office.layout.js for the object/zone schema.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT_JS = path.join(ROOT, "public/office.layout.js");
const VALIDATE_JS = path.join(ROOT, "public/office.validate.js");
const TILED_JSON = path.join(ROOT, "public/office.tiled.json");
const PALETTE_PNG = path.join(ROOT, "public/office-palette.png");
const TS = 16;

// palette order == local tile id; gid = id + 1. glyph, [r,g,b]
const PALETTE = [
  [".", [26, 28, 34]],
  ["#", [60, 64, 74]],
  ["w", [64, 72, 90]],
  ["m", [70, 110, 150]],
  ["d", [210, 160, 90]],
];
const GLYPH_OF_GID = (gid) => PALETTE[(gid & 0x0fffffff) - 1]?.[0] ?? ".";
const GID_OF_GLYPH = (g) => PALETTE.findIndex((p) => p[0] === g) + 1 || 1;

/* ─────────────────────────── read office.layout.js ─────────────────────── */

function readLayout() {
  const src = fs.readFileSync(LAYOUT_JS, "utf8");
  const win = {};
  new Function("window", src)(win); // trusted local file, not user input
  if (!win.OFFICE_LAYOUT) throw new Error("office.layout.js did not set window.OFFICE_LAYOUT");
  return win.OFFICE_LAYOUT;
}

/** Run the shared validator (office.validate.js) and print any warnings. */
function checkLayout(L) {
  let validate;
  try {
    const win = {};
    new Function("window", fs.readFileSync(VALIDATE_JS, "utf8"))(win);
    validate = win.validateOfficeLayout;
  } catch {
    return; // validator missing / unreadable — skip quietly
  }
  const warnings = validate(L) ?? [];
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  if (warnings.length) console.warn(`  (${warnings.length} layout warning${warnings.length === 1 ? "" : "s"})`);
}

/* ─────────────────────────────── init ─────────────────────────────────── */

function propArr(obj) {
  return Object.entries(obj).map(([name, value]) => ({
    name,
    type: typeof value === "number" ? "int" : "string",
    value,
  }));
}

function init() {
  const L = readLayout();
  checkLayout(L);
  const cols = L.cols ?? L.tiles[0].length;
  const rows = L.rows ?? L.tiles.length;

  const data = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) data.push(GID_OF_GLYPH(L.tiles[r][c] ?? "."));

  let nextId = 1;
  const objects = [];
  for (const o of L.objects ?? []) {
    if (o.type === "table") {
      const [c0, r0, c1, r1] = o.rect;
      objects.push({
        id: nextId++, name: "", type: "table", visible: true, rotation: 0,
        x: c0 * TS, y: r0 * TS, width: (c1 - c0 + 1) * TS, height: (r1 - r0 + 1) * TS,
      });
    } else if (o.type === "board") {
      objects.push({
        id: nextId++, name: "", type: "board", visible: true, rotation: 0,
        x: o.panel[0] * TS, y: (rows - 1) * TS, width: o.panel[1] * TS, height: TS,
      });
    } else {
      const obj = {
        id: nextId++, name: o.id ?? "", type: o.type, visible: true, rotation: 0,
        x: o.col * TS + TS / 2, y: o.row * TS + TS / 2, width: 0, height: 0, point: true,
      };
      if (o.face) obj.properties = propArr({ face: o.face });
      objects.push(obj);
    }
  }
  for (const z of L.zones ?? []) {
    const [c0, r0, c1, r1] = z.rect;
    objects.push({
      id: nextId++, name: z.label ?? "", type: "zone", visible: true, rotation: 0,
      x: c0 * TS, y: r0 * TS, width: (c1 - c0 + 1) * TS, height: (r1 - r0 + 1) * TS,
      properties: propArr({ label: z.label ?? "", desks: (z.desks ?? []).join(","), tint: z.tint ?? "" }),
    });
  }

  const map = {
    type: "map", version: "1.10", tiledversion: "1.10.2",
    orientation: "orthogonal", renderorder: "right-down", infinite: false,
    width: cols, height: rows, tilewidth: TS, tileheight: TS, nextlayerid: 3, nextobjectid: nextId,
    tilesets: [{
      firstgid: 1, name: "palette", image: "office-palette.png",
      imagewidth: PALETTE.length * TS, imageheight: TS,
      tilewidth: TS, tileheight: TS, tilecount: PALETTE.length, columns: PALETTE.length, margin: 0, spacing: 0,
    }],
    layers: [
      { id: 1, type: "tilelayer", name: "structure", visible: true, opacity: 1,
        x: 0, y: 0, width: cols, height: rows, data },
      { id: 2, type: "objectgroup", name: "objects", visible: true, opacity: 1,
        x: 0, y: 0, draworder: "topdown", objects },
    ],
  };

  fs.writeFileSync(TILED_JSON, JSON.stringify(map, null, 1) + "\n");
  if (!fs.existsSync(PALETTE_PNG)) writePalettePng();
  console.log(`wrote ${rel(TILED_JSON)}${fs.existsSync(PALETTE_PNG) ? "" : " + " + rel(PALETTE_PNG)}`);
  console.log("open it in Tiled, edit, then: npm run map");
}

/* ─────────────────────────── Tiled -> layout ──────────────────────────── */

function props(o) {
  const out = {};
  for (const p of o.properties ?? []) out[p.name] = p.value;
  return out;
}
const isRect = (o) => !o.point && !o.gid && o.width > 0 && o.height > 0;
const rectCells = (o) => [
  Math.round(o.x / TS),
  Math.round(o.y / TS),
  Math.round((o.x + o.width) / TS) - 1,
  Math.round((o.y + o.height) / TS) - 1,
];
function pointCell(o) {
  // tile objects anchor at the bottom-left; points / rects at the top-left
  const col = Math.floor(o.x / TS);
  const row = o.gid ? Math.round(o.y / TS) - 1 : Math.floor(o.y / TS);
  return [col, row];
}
const SEAT = { up: (c, r) => [c, r + 1], down: (c, r) => [c, r - 1], left: (c, r) => [c - 1, r], right: (c, r) => [c + 1, r] };

function build() {
  const map = JSON.parse(fs.readFileSync(TILED_JSON, "utf8"));
  if (map.orientation !== "orthogonal") throw new Error("map must be orthogonal");
  if (map.tilewidth !== TS || map.tileheight !== TS) throw new Error(`tiles must be ${TS}px`);

  const tl = map.layers.find((l) => l.type === "tilelayer" && l.name === "structure")
    ?? map.layers.find((l) => l.type === "tilelayer");
  if (!tl) throw new Error('no tile layer (name it "structure")');
  const cols = tl.width, rows = tl.height;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    let row = "";
    for (let c = 0; c < cols; c++) row += GLYPH_OF_GID(tl.data[r * cols + c] || 0);
    tiles.push(row);
  }

  const og = map.layers.find((l) => l.type === "objectgroup");
  const objects = [];
  const zones = [];
  for (const o of og?.objects ?? []) {
    const type = o.type || o.class || "";
    const p = props(o);
    if (type === "table") {
      const [c0, r0, c1, r1] = rectCells(o);
      objects.push({ type: "table", rect: [c0, r0, c1, r1] });
    } else if (type === "board") {
      const [c0, r0, , c1] = [Math.round(o.x / TS), 0, 0, Math.round((o.x + o.width) / TS) - 1];
      const panelCols = c1 - c0 + 1;
      const cells = [];
      for (let c = c0 + 1; c <= c0 + panelCols - 2; c++) cells.push([c, rows - 2]);
      objects.push({ type: "board", panel: [c0, panelCols], cells });
    } else if (type === "zone") {
      const [c0, r0, c1, r1] = rectCells(o);
      zones.push({
        label: p.label || o.name || "",
        desks: String(p.desks || "").split(",").map((s) => s.trim()).filter(Boolean),
        rect: [c0, r0, c1, r1],
        tint: p.tint || "rgba(255,255,255,0.05)",
      });
    } else if (type) {
      const [col, row] = isRect(o) ? rectCells(o) : pointCell(o);
      const entry = { type, col, row };
      if (type === "desk") {
        entry.id = o.name || `desk_${col}_${row}`;
        entry.face = p.face || "up";
        entry.seat = (SEAT[entry.face] || SEAT.up)(col, row);
      }
      objects.push(entry);
    }
  }

  const layout = { cols, rows, tiles, objects, zones };
  fs.writeFileSync(LAYOUT_JS, render(layout));
  console.log(`wrote ${rel(LAYOUT_JS)}  (${cols}×${rows}, ${objects.length} objects, ${zones.length} zones)`);
  checkLayout(layout);
}

/* ───────────────────────── emit office.layout.js ──────────────────────── */

const HEADER = `/*
 * THE OFFICE FLOOR PLAN — decoded by render.js at load. Rearrange the office by
 * editing this file (or office.tiled.json in Tiled, then \`npm run map\`).
 *
 * GENERATED from public/office.tiled.json by scripts/build-layout.mjs. To hand-
 * edit instead, delete office.tiled.json — this file is then yours.
 *
 * Coordinates are 0-indexed tile cells: col = x (0 = left), row = y (0 = top).
 *
 * tiles  — one string per row, same length. Glyphs: # structural wall ·
 *          w meeting-room wall · . floor · m meeting carpet · d door. Walls and
 *          carpet auto-tile from neighbours; just draw the shape.
 * objects — free props, each { "type", … }:
 *   desk  { id, col, row, face:"up"|"down"|"left"|"right", seat:[col,row] }
 *           id is a CONTRACT with the engine (agent_registered.desk):
 *           desk_dev / desk_research / desk_manager / hire_1..hire_6, matching
 *           HIRE_DESKS in src/orchestrator/office.ts.
 *   plant | water | snack | break | shelf | door   { col, row }
 *           (shelf = library bookshelf; the reading spot is the tile to its left)
 *   table { rect:[c0,r0,c1,r1] }   meeting table, inclusive bounds
 *   board { panel:[startCol,cols], cells:[[col,row],…] }
 *           panel = where the kanban board is drawn on the wall;
 *           cells = tiles a worker stands on to post / take a card
 * zones  — faint labelled washes behind a group of hire desks; \`desks\` mirrors
 *          HIRE_ZONES in office.ts. { label, desks:[…], rect:[c0,r0,c1,r1], tint }
 */
`;

function render(L) {
  const line = (o) => "    " + JSON.stringify(o);
  return (
    HEADER +
    "window.OFFICE_LAYOUT = {\n" +
    `  cols: ${L.cols},\n  rows: ${L.rows},\n\n` +
    "  tiles: [\n" + L.tiles.map((t) => `    ${JSON.stringify(t)},`).join("\n") + "\n  ],\n\n" +
    "  objects: [\n" + L.objects.map(line).join(",\n") + "\n  ],\n\n" +
    "  zones: [\n" + L.zones.map(line).join(",\n") + "\n  ],\n};\n"
  );
}

/* ─────────────────────────── minimal PNG writer ───────────────────────── */

function writePalettePng() {
  const w = PALETTE.length * TS, h = TS;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    let off = y * (1 + w * 3) + 1; // +1: filter byte 0
    for (let x = 0; x < w; x++) {
      const [, [r, g, b]] = PALETTE[Math.floor(x / TS)];
      raw[off++] = r; raw[off++] = g; raw[off++] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(PALETTE_PNG, png);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/* ──────────────────────────────── main ───────────────────────────────── */

const rel = (p) => path.relative(ROOT, p);
try {
  if (process.argv[2] === "init") init();
  else if (fs.existsSync(TILED_JSON)) build();
  else {
    console.error(`${rel(TILED_JSON)} not found.\nRun \`node scripts/build-layout.mjs init\` to create it from the current layout.`);
    process.exit(1);
  }
} catch (err) {
  console.error(`build-layout: ${err.message}`);
  process.exit(1);
}
