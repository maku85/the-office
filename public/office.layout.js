/*
 * THE OFFICE FLOOR PLAN — decoded by render.js at load. Rearrange the office by
 * editing this file (or office.tiled.json in Tiled, then `npm run map`).
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
 * zones  — faint labelled washes behind a group of hire desks; `desks` mirrors
 *          HIRE_ZONES in office.ts. { label, desks:[…], rect:[c0,r0,c1,r1], tint }
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
    {"type":"desk","col":3,"row":2,"id":"desk_dev","face":"up","seat":[3,3]},
    {"type":"desk","col":16,"row":2,"id":"desk_research","face":"up","seat":[16,3]},
    {"type":"desk","col":16,"row":10,"id":"desk_manager","face":"down","seat":[16,9]},
    {"type":"desk","col":6,"row":2,"id":"hire_1","face":"up","seat":[6,3]},
    {"type":"desk","col":9,"row":2,"id":"hire_2","face":"up","seat":[9,3]},
    {"type":"desk","col":12,"row":2,"id":"hire_3","face":"up","seat":[12,3]},
    {"type":"desk","col":6,"row":10,"id":"hire_4","face":"down","seat":[6,9]},
    {"type":"desk","col":9,"row":10,"id":"hire_5","face":"down","seat":[9,9]},
    {"type":"desk","col":12,"row":10,"id":"hire_6","face":"down","seat":[12,9]},
    {"type":"plant","col":1,"row":1},
    {"type":"plant","col":18,"row":1},
    {"type":"plant","col":1,"row":11},
    {"type":"plant","col":18,"row":11},
    {"type":"water","col":10,"row":11},
    {"type":"snack","col":1,"row":9},
    {"type":"break","col":2,"row":9},
    {"type":"break","col":3,"row":9},
    {"type":"break","col":2,"row":10},
    {"type":"break","col":3,"row":10},
    {"type":"shelf","col":18,"row":5},
    {"type":"shelf","col":18,"row":6},
    {"type":"shelf","col":18,"row":7},
    {"type":"table","rect":[7,5,12,6]},
    {"type":"door","col":9,"row":12},
    {"type":"board","panel":[12,6],"cells":[[13,11],[14,11],[15,11],[16,11]]}
  ],

  zones: [
    {"label":"BUILD","desks":["hire_1","hire_2","hire_3"],"rect":[5,1,13,3],"tint":"rgba(96,150,210,0.06)"},
    {"label":"PLAN","desks":["hire_4","hire_5","hire_6"],"rect":[5,9,13,11],"tint":"rgba(210,160,90,0.06)"}
  ],
};
