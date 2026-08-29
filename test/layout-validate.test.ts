import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// office.validate.js is a plain browser script that sets a global — load it the
// same way scripts/build-layout.mjs does.
function load<T>(file: string, key: string): T {
  const win: Record<string, unknown> = {};
  new Function("window", fs.readFileSync(path.join(ROOT, file), "utf8"))(win);
  return win[key] as T;
}

type Obj = { type: string; id?: string; col?: number; row?: number; face?: string; seat?: number[] };
type Layout = { cols: number; rows: number; tiles: string[]; objects: Obj[]; zones: unknown[] };
const validate = load<(L: unknown) => string[]>("public/office.validate.js", "validateOfficeLayout");
const shipped = load<Layout>("public/office.layout.js", "OFFICE_LAYOUT");
const clone = (): Layout => JSON.parse(JSON.stringify(shipped));

test("the shipped floor plan is clean", () => {
  assert.deepEqual(validate(shipped), []);
});

test("a missing engine desk is flagged (and the zone that names it)", () => {
  const L = clone();
  L.objects = L.objects.filter((o) => o.id !== "hire_3");
  const w = validate(L);
  assert.ok(w.some((s) => /missing desk "hire_3"/.test(s)));
  assert.ok(w.some((s) => /zone "BUILD" lists desk "hire_3"/.test(s)));
});

test("a stray desk id is flagged", () => {
  const L = clone();
  L.objects.push({ type: "desk", id: "hire_9", col: 2, row: 2, face: "up", seat: [2, 3] });
  assert.ok(validate(L).some((s) => /desk "hire_9" is not one the engine assigns to/.test(s)));
});

test("a seat on a non-walkable tile is flagged", () => {
  const L = clone();
  (L.objects.find((o) => o.id === "desk_dev")!).seat = [3, 4]; // 'w' carpet-wall
  L.tiles[4] = "#..wwwwwwwwwwwww...#";
  assert.ok(validate(L).some((s) => /desk "desk_dev" seat \(3,4\)/.test(s)));
});

test("furniture on a wall tile is flagged", () => {
  const L = clone();
  (L.objects.find((o) => o.type === "plant")!).col = 0; // outer wall
  assert.ok(validate(L).some((s) => /plant sits on a wall tile at \(0,/.test(s)));
});

test("a walled-off seat (no path from the door) is flagged", () => {
  const L = clone();
  (L.objects.find((o) => o.id === "desk_dev")!).seat = [8, 6]; // meeting carpet
  L.tiles[8] = "#.....wwwwwwww.....#"; // seal the meeting room's door
  assert.ok(validate(L).some((s) => /walled off — no path from the door/.test(s)));
});

test("a wrong-length row and a missing door are flagged", () => {
  const L = clone();
  L.tiles[1] = L.tiles[1] + "#";
  L.objects = L.objects.filter((o) => o.type !== "door");
  const w = validate(L);
  assert.ok(w.some((s) => /row 1 is \d+ chars, expected 20/.test(s)));
  assert.ok(w.some((s) => /no door object/.test(s)));
});

test("two objects on the same tile are flagged", () => {
  const L = clone();
  L.objects.push({ type: "plant", col: 10, row: 11 }); // where the water cooler is
  assert.ok(validate(L).some((s) => /both sit on \(10,11\)/.test(s)));
});

test("an empty layout returns a single warning, not a crash", () => {
  assert.deepEqual(validate({ tiles: [] }), ["layout has no tiles"]);
  assert.deepEqual(validate(null), ["layout has no tiles"]);
});
