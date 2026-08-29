/*
 * Deterministic sanity checks on the decoded floor plan. WARNINGS ONLY — the
 * office still renders; you just find out you parked a desk on a wall.
 *
 * Shared by render.js (console.warn on load) and scripts/build-layout.mjs
 * (prints them). Kept a plain browser-style script that sets a global so both
 * can load it the same way (new Function("window", src)).
 */
(function () {
  const WALK = new Set([".", "m", "d"]); // floor · carpet · door
  const GLYPHS = new Set(["#", "w", ".", "m", "d"]);

  // Desk ids the engine assigns agents to — the seed desks in src/main.ts plus
  // HIRE_DESKS in src/orchestrator/office.ts. A desk not in this set stays empty;
  // a missing one leaves an agent with nowhere to sit.
  const ENGINE_DESKS = [
    "desk_dev", "desk_research", "desk_manager",
    "hire_1", "hire_2", "hire_3", "hire_4", "hire_5", "hire_6",
  ];

  function validateOfficeLayout(L) {
    const out = [];
    if (!L || !Array.isArray(L.tiles) || L.tiles.length === 0) return ["layout has no tiles"];

    const rows = L.tiles.length;
    const cols = L.tiles[0].length;
    const inBounds = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;
    const at = (c, r) => (inBounds(c, r) ? L.tiles[r][c] : "#");

    // ── grid ──────────────────────────────────────────────────────────────
    if (L.cols != null && L.cols !== cols) out.push(`cols is ${L.cols} but row 0 is ${cols} wide`);
    if (L.rows != null && L.rows !== rows) out.push(`rows is ${L.rows} but there are ${rows} rows`);
    L.tiles.forEach((row, r) => {
      if (row.length !== cols) out.push(`row ${r} is ${row.length} chars, expected ${cols}`);
      for (const ch of row) {
        if (!GLYPHS.has(ch)) { out.push(`row ${r} has an unknown glyph "${ch}" (use # w . m d)`); break; }
      }
    });

    const objs = Array.isArray(L.objects) ? L.objects : [];
    const desks = objs.filter((o) => o.type === "desk");
    const deskIds = new Set(desks.map((d) => d.id));

    // ── desks vs the engine contract ──────────────────────────────────────
    for (const id of ENGINE_DESKS) {
      if (!deskIds.has(id)) out.push(`missing desk "${id}" — the engine has nowhere to seat that agent`);
    }
    for (const d of desks) {
      if (d.id && !ENGINE_DESKS.includes(d.id)) out.push(`desk "${d.id}" is not one the engine assigns to — it stays empty`);
    }

    // ── objects on the grid ───────────────────────────────────────────────
    for (const o of objs) {
      const label = `${o.type}${o.id ? ` "${o.id}"` : ""}`;
      if (o.type === "table") {
        const [c0, r0, c1, r1] = o.rect || [];
        if (![c0, r0, c1, r1].every(Number.isInteger) || !inBounds(c0, r0) || !inBounds(c1, r1)) {
          out.push(`table rect ${JSON.stringify(o.rect)} is out of bounds`);
        }
        continue;
      }
      if (o.type === "board") {
        const [pc, pn] = o.panel || [];
        if (!Number.isInteger(pc) || !Number.isInteger(pn) || pc < 0 || pc + pn > cols) {
          out.push(`board panel ${JSON.stringify(o.panel)} runs off the grid`);
        }
        continue;
      }
      if (!inBounds(o.col, o.row)) { out.push(`${label} at (${o.col},${o.row}) is out of bounds`); continue; }
      if ((at(o.col, o.row) === "#" || at(o.col, o.row) === "w") && o.type !== "door") {
        out.push(`${label} sits on a wall tile at (${o.col},${o.row})`);
      }
      if (o.type === "desk") {
        const [sc, sr] = o.seat || [];
        if (!inBounds(sc, sr)) out.push(`desk "${o.id}" seat (${sc},${sr}) is out of bounds`);
        else if (!WALK.has(at(sc, sr))) out.push(`desk "${o.id}" seat (${sc},${sr}) is a "${at(sc, sr)}" tile — an agent can't sit there`);
      }
    }

    // ── every seat reachable from the door ────────────────────────────────
    const door = objs.find((o) => o.type === "door");
    if (!door) out.push("no door object");
    else if (inBounds(door.col, door.row)) {
      const seen = new Set();
      const stack = [[door.col, door.row]];
      while (stack.length) {
        const [c, r] = stack.pop();
        const k = c + "," + r;
        if (seen.has(k) || !inBounds(c, r) || !WALK.has(at(c, r))) continue;
        seen.add(k);
        stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
      }
      for (const d of desks) {
        const [sc, sr] = d.seat || [];
        if (inBounds(sc, sr) && WALK.has(at(sc, sr)) && !seen.has(sc + "," + sr)) {
          out.push(`desk "${d.id}" seat (${sc},${sr}) is walled off — no path from the door`);
        }
      }
    }

    // ── two things on one tile ───────────────────────────────────────────
    const spot = new Map();
    for (const o of objs) {
      if (o.rect || o.panel) continue;
      const k = o.col + "," + o.row;
      if (spot.has(k)) out.push(`${spot.get(k)} and ${o.type} both sit on (${o.col},${o.row})`);
      else spot.set(k, o.type + (o.id ? ` "${o.id}"` : ""));
    }

    // ── zones ────────────────────────────────────────────────────────────
    for (const z of L.zones || []) {
      for (const id of z.desks || []) {
        if (!deskIds.has(id)) out.push(`zone "${z.label}" lists desk "${id}", which isn't in the layout`);
      }
      const [c0, r0, c1, r1] = z.rect || [];
      if (!inBounds(c0, r0) || !inBounds(c1, r1)) out.push(`zone "${z.label}" rect ${JSON.stringify(z.rect)} is out of bounds`);
    }

    return out;
  }

  (typeof window !== "undefined" ? window : globalThis).validateOfficeLayout = validateOfficeLayout;
})();
