/*
 * THE OFFICE FLOOR PLAN — edit this file to rearrange the office. Nothing else
 * changes: render.js decodes this at load, keeps its procedural drawing, tile
 * skin and auto-tiling untouched.
 *
 * Coordinates are 0-indexed tile cells. col = x (0 = left), row = y (0 = top).
 *
 * ── tiles ──────────────────────────────────────────────────────────────────
 *   One string per row, all the same length. Glyphs:
 *     #  outer / structural wall        .  floor
 *     w  meeting-room wall              m  meeting-room carpet
 *     d  door (walkable gap in a wall)
 *   Walls and carpet auto-tile from their neighbours — just draw the shape.
 *
 * ── objects ────────────────────────────────────────────────────────────────
 *   Free-placed props. Every entry has a "type"; the rest depends on it:
 *     desk   { id, col, row, face:"up"|"down", seat:[col,row] }
 *              `id` is a CONTRACT with the engine — agent_registered events
 *              carry a desk id (desk_dev / desk_research / desk_manager /
 *              hire_1..hire_6, matching HIRE_DESKS in src/orchestrator/office.ts).
 *              Rename/add here only alongside those.
 *     plant  { col, row }
 *     water  { col, row }              (water cooler; one)
 *     snack  { col, row }              (break-room vending machine; one)
 *     break  { col, row }              (break-room floor tile; repeat for each)
 *     shelf  { col, row }              (library bookshelf; the reading spot is
 *                                       the tile immediately to its LEFT)
 *     table  { rect:[c0,r0,c1,r1] }    (meeting table, inclusive bounds; one)
 *     door   { col, row }              (the entrance agents walk in/out of; one)
 *     board  { panel:[startCol,cols], cells:[[col,row],...] }
 *              panel = where the kanban board is drawn on the wall;
 *              cells  = tiles a worker stands on to post / take a card.
 *
 * ── zones ──────────────────────────────────────────────────────────────────
 *   Faint labelled washes drawn behind a group of hire desks. `desks` mirrors
 *   HIRE_ZONES in src/orchestrator/office.ts (heavy-tier hires → BUILD, the
 *   rest → PLAN). rect = [c0,r0,c1,r1] inclusive. Purely cosmetic.
 */
window.OFFICE_LAYOUT = {
  cols: 20,
  rows: 13,

  tiles: [
    "####################",
    "#..................#",
    "#..................#",
    "#..................#",
    "#.....wwwwwwww.....#",
    "#.....wmmmmmmw.....#",
    "#.....wmmmmmmw.....#",
    "#.....wmmmmmmw.....#",
    "#.....wwwddwww.....#",
    "#..................#",
    "#..................#",
    "#..................#",
    "########ddd#########",
  ],

  objects: [
    { type: "desk", id: "desk_dev",      col: 3,  row: 2,  face: "up",   seat: [3, 3] },
    { type: "desk", id: "desk_research", col: 16, row: 2,  face: "up",   seat: [16, 3] },
    { type: "desk", id: "desk_manager",  col: 16, row: 10, face: "down", seat: [16, 9] },
    { type: "desk", id: "hire_1", col: 6,  row: 2,  face: "up",   seat: [6, 3] },
    { type: "desk", id: "hire_2", col: 9,  row: 2,  face: "up",   seat: [9, 3] },
    { type: "desk", id: "hire_3", col: 12, row: 2,  face: "up",   seat: [12, 3] },
    { type: "desk", id: "hire_4", col: 6,  row: 10, face: "down", seat: [6, 9] },
    { type: "desk", id: "hire_5", col: 9,  row: 10, face: "down", seat: [9, 9] },
    { type: "desk", id: "hire_6", col: 12, row: 10, face: "down", seat: [12, 9] },

    { type: "plant", col: 1,  row: 1 },
    { type: "plant", col: 18, row: 1 },
    { type: "plant", col: 1,  row: 11 },
    { type: "plant", col: 18, row: 11 },

    { type: "water", col: 10, row: 11 },
    { type: "snack", col: 1,  row: 9 },
    { type: "break", col: 2, row: 9 },
    { type: "break", col: 3, row: 9 },
    { type: "break", col: 2, row: 10 },
    { type: "break", col: 3, row: 10 },

    { type: "shelf", col: 18, row: 5 },
    { type: "shelf", col: 18, row: 6 },
    { type: "shelf", col: 18, row: 7 },

    { type: "table", rect: [7, 5, 12, 6] },
    { type: "door",  col: 9, row: 12 },
    { type: "board", panel: [12, 6], cells: [[13, 11], [14, 11], [15, 11], [16, 11]] },
  ],

  zones: [
    { label: "BUILD", desks: ["hire_1", "hire_2", "hire_3"], rect: [5, 1, 13, 3],  tint: "rgba(96,150,210,0.06)" },
    { label: "PLAN",  desks: ["hire_4", "hire_5", "hire_6"], rect: [5, 9, 13, 11], tint: "rgba(210,160,90,0.06)" },
  ],
};
