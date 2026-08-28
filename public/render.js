// Pixel-art top-down office renderer. Sprites are baked once into offscreen
// atlases at startup (a shared tile/furniture atlas, one character sheet per
// agent) and blitted with drawImage — no per-frame primitive spam, and room for
// real detail and animation frames. The room surfaces + generic furniture are
// re-skinned at load from a bundled Kenney CC0 spritesheet (see KENNEY_MAP);
// /assets/office-tiles.png still replaces the whole tile atlas if present.

(function () {
  const TILE = 16;
  const SCALE = 3;
  const PX = TILE * SCALE;

  // # wall  . floor  w meeting wall  m carpet  d door
  const MAP = [
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
  ];
  const COLS = MAP[0].length;
  const ROWS = MAP.length;
  const SOLID = new Set(["#", "w"]);
  const WALK = new Set([".", "m", "d"]);

  const DESKS = {
    desk_dev: { deskC: 3, deskR: 2, seatC: 3, seatR: 3, face: "up" },
    desk_research: { deskC: 16, deskR: 2, seatC: 16, seatR: 3, face: "up" },
    desk_manager: { deskC: 16, deskR: 10, seatC: 16, seatR: 9, face: "down" },
    // free desks handed out to hired specialists (see HIRE_DESKS in office.ts)
    hire_1: { deskC: 6, deskR: 2, seatC: 6, seatR: 3, face: "up" },
    hire_2: { deskC: 9, deskR: 2, seatC: 9, seatR: 3, face: "up" },
    hire_3: { deskC: 12, deskR: 2, seatC: 12, seatR: 3, face: "up" },
    hire_4: { deskC: 6, deskR: 10, seatC: 6, seatR: 9, face: "down" },
    hire_5: { deskC: 9, deskR: 10, seatC: 9, seatR: 9, face: "down" },
    hire_6: { deskC: 12, deskR: 10, seatC: 12, seatR: 9, face: "down" },
  };
  const PLANTS = [
    { c: 1, r: 1 }, { c: 18, r: 1 }, { c: 1, r: 11 }, { c: 18, r: 11 },
  ];
  const WATER = { c: 10, r: 11 };
  const SNACK = { c: 1, r: 9 };
  const BREAK_TILES = [
    { c: 2, r: 9 }, { c: 3, r: 9 }, { c: 2, r: 10 }, { c: 3, r: 10 },
  ];
  // library: bookshelves against the right wall, reading spots just in front
  const LIBRARY_SHELVES = [
    { c: 18, r: 5 }, { c: 18, r: 6 }, { c: 18, r: 7 },
  ];
  const LIBRARY_TILES = [
    { c: 17, r: 5 }, { c: 17, r: 6 }, { c: 17, r: 7 },
  ];
  const TABLE = { c0: 7, r0: 5, c1: 12, r1: 6 };
  const MEETING_SEATS = [
    { c: 7, r: 7, face: "up" },
    { c: 9, r: 7, face: "up" },
    { c: 11, r: 7, face: "up" },
    { c: 8, r: 5, face: "down" },
    { c: 11, r: 5, face: "down" },
  ];
  const DOOR = { c: 9, r: 12 };

  // kanban board on the bottom wall, right of the door
  const BOARD = { c0: 12, cols: 6 };
  const BOARD_TILES = [
    { c: 13, r: 11 }, { c: 14, r: 11 }, { c: 15, r: 11 }, { c: 16, r: 11 },
  ];

  // role zones the manager's hires sit in (mirrors HIRE_ZONES in office.ts):
  // heavy-tier roles above the meeting room, everyone else below it
  const ZONES = [
    { desks: ["hire_1", "hire_2", "hire_3"], c0: 5, c1: 13, r0: 1, r1: 3, label: "BUILD", tint: "rgba(96,150,210,0.06)" },
    { desks: ["hire_4", "hire_5", "hire_6"], c0: 5, c1: 13, r0: 9, r1: 11, label: "PLAN", tint: "rgba(210,160,90,0.06)" },
  ];
  const BUSY_STATES = ["working", "thinking", "blocked", "waiting"];

  const STATE_COLOR = {
    idle: "#8b93a3", thinking: "#93c5fd", working: "#6ee7b7",
    waiting: "#fbbf24", blocked: "#f87171", done: "#a7f3d0",
  };
  const INK = "#d7dbe3";
  const DIM = "#8b93a3";

  /* ---------- colour helpers ---------- */

  /** HSL (h 0-360, s/l 0-1) → [r,g,b] 0-255. */
  function hslRgb(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }
  /** [r,g,b] 0-255 → [h 0-360, s 0-1, l 0-1]. */
  function rgbHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn;
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h =
      mx === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 :
      mx === g ? ((b - r) / d + 2) * 60 :
                 ((r - g) / d + 4) * 60;
    return [h, s, l];
  }
  /** HSL (h 0-360, s/l 0-100) → #rrggbb, so the palette can hand `shade()` hex. */
  function hslHex(h, s, l) {
    return "#" + hslRgb(h, s / 100, l / 100).map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const cl = (v) => Math.max(0, Math.min(255, v));
    const r = cl(((n >> 16) & 255) + amt);
    const g = cl(((n >> 8) & 255) + amt);
    const b = cl((n & 255) + amt);
    return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  const AGENT_PAL = {
    carol: { hair: "#6b4a2a", shirt: "#b3543f" },
    bob: { hair: "#2e2e2e", shirt: "#4f7db3" },
    alice: { hair: "#b5793a", shirt: "#5fa06a" },
  };
  const PAL_CACHE = new Map();
  let palCount = 0;
  function palFor(id) {
    let cached = PAL_CACHE.get(id);
    if (cached) return cached;
    const base = AGENT_PAL[id];
    let hair, shirt;
    if (base) {
      hair = base.hair;
      shirt = base.shirt;
    } else {
      // golden-angle hue spacing → each new hire looks as distinct as possible
      // (offset so the first hire isn't carol's red)
      const hue = Math.round((50 + palCount++ * 137.508) % 360);
      shirt = hslHex(hue, 44, 52);
      hair = hslHex((hue + 200) % 360, 16, 24);
    }
    const pal = {
      skin: "#e8b98f", skinDk: "#c9976f",
      hair, hairDk: shade(hair, -34),
      shirt, shirtDk: shade(shirt, -34),
      pants: "#3a3a44", shoes: "#22232b",
      line: "#1b1c22",
    };
    PAL_CACHE.set(id, pal);
    return pal;
  }

  /* ---------- offscreen canvas ---------- */

  function makeCanvas(w, h) {
    let cv;
    if (typeof OffscreenCanvas === "function") cv = new OffscreenCanvas(w, h);
    else {
      cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
    }
    const c = cv.getContext("2d");
    c.imageSmoothingEnabled = false;
    return { cv, c };
  }
  const R = (c, x, y, w, h, col) => {
    c.fillStyle = col;
    c.fillRect(x | 0, y | 0, Math.ceil(w), Math.ceil(h));
  };

  /* ---------- tile / furniture atlas ---------- */
  // Layout (in 16px cells): keyed rects returned as [sx, sy, sw, sh].

  const A = {}; // name -> [sx,sy,sw,sh]
  function buildTileAtlas() {
    const { cv, c } = makeCanvas(256, 160);

    // --- floor variants (16x16) ---
    function floor(sx, base) {
      R(c, sx, 0, 16, 16, base);
      R(c, sx, 0, 16, 16, base);
      for (let i = 0; i < 10; i++) {
        const px = sx + ((i * 7 + 3) % 15);
        const py = (i * 5 + 2) % 15;
        R(c, px, py, 1, 1, shade(base, i % 2 ? 6 : -6));
      }
      R(c, sx, 15, 16, 1, shade(base, -10));
      R(c, sx + 15, 0, 1, 16, shade(base, -10));
    }
    floor(0, "#242833"); A.floor0 = [0, 0, 16, 16];
    floor(16, "#20242e"); A.floor1 = [16, 0, 16, 16];

    // carpet (woven) — flat base; the rug border comes from the autotile overlay
    function carpet(sx) {
      R(c, sx, 0, 16, 16, "#3a3350");
      for (let y = 0; y < 16; y += 2)
        for (let x = 0; x < 16; x += 2)
          R(c, sx + x + ((y / 2) % 2), y, 1, 1, "#453c63");
    }
    carpet(32); A.carpet = [32, 0, 16, 16];

    // wall bases — flat body; crown / shadow / side edges come from the overlay
    R(c, 48, 0, 16, 16, "#3b3f4a"); A.wall = [48, 0, 16, 16];
    R(c, 64, 0, 16, 16, "#40454f"); A.wallInner = [64, 0, 16, 16];

    // ── auto-tile edge overlays ────────────────────────────────────
    // 16 cells indexed by a 4-bit "same-material neighbour" mask
    // (1=N, 2=E, 4=S, 8=W). A strip is drawn on every side whose bit is 0,
    // so runs stay seamless and only the exposed edges get a border.
    A.wallEdges = [];
    for (let m = 0; m < 16; m++) {
      const ex = m * 16, ey = 16;
      if (!(m & 1)) { R(c, ex, ey, 16, 4, "#565c6b"); R(c, ex, ey + 4, 16, 1, "#2c2f38"); }
      if (!(m & 4)) R(c, ex, ey + 13, 16, 3, "#23252d");
      if (!(m & 8)) R(c, ex, ey, 3, 16, "#31353f");
      if (!(m & 2)) R(c, ex + 13, ey, 3, 16, "#31353f");
      A.wallEdges.push([ex, ey, 16, 16]);
    }
    A.carpetEdges = [];
    for (let m = 0; m < 16; m++) {
      const ex = m * 16, ey = 32;
      if (!(m & 1)) R(c, ex, ey, 16, 2, "rgba(255,255,255,0.15)");
      if (!(m & 4)) R(c, ex, ey + 14, 16, 2, "rgba(0,0,0,0.28)");
      if (!(m & 8)) R(c, ex, ey, 2, 16, "rgba(255,255,255,0.10)");
      if (!(m & 2)) R(c, ex + 14, ey, 2, 16, "rgba(255,255,255,0.10)");
      A.carpetEdges.push([ex, ey, 16, 16]);
    }

    // door (floor with frame nub)
    R(c, 80, 0, 16, 16, "#242833");
    R(c, 80, 0, 2, 16, "#4a3f2e");
    R(c, 94, 0, 2, 16, "#4a3f2e");
    A.door = [80, 0, 16, 16];

    // --- desk, 16x16, monitor on the "north" edge (for up-facing seat) ---
    function desk(sx, down) {
      const top = down ? 3 : 6;
      R(c, sx + 1, top, 14, 8, "#7a5a3d");
      R(c, sx + 1, top, 14, 1, "#906c49");
      R(c, sx + 1, top + 7, 14, 1, "#5c4530");
      // wood grain
      R(c, sx + 3, top + 3, 10, 1, "#6c4f34");
      R(c, sx + 5, top + 5, 8, 1, "#6c4f34");
      // drawer
      R(c, sx + 10, top + 2, 4, 4, "#5c4530");
      R(c, sx + 11, top + 3, 2, 1, "#8a6a49");
      // monitor
      const my = down ? sx * 0 + 11 : 1;
      R(c, sx + 4, my, 8, 5, "#14161d");
      R(c, sx + 5, my + 1, 6, 3, "#2b3550");
      R(c, sx + 7, my + 5, 2, 1, "#0f1014");
    }
    desk(96, false); A.deskUp = [96, 0, 16, 16];
    desk(112, true); A.deskDown = [112, 0, 16, 16];

    // chair
    R(c, 128 + 5, 3, 6, 8, "#2b2f3a");
    R(c, 128 + 5, 3, 6, 2, "#363b48");
    R(c, 128 + 6, 11, 4, 3, "#1c1f26");
    A.chair = [128, 0, 16, 16];

    // plant
    R(c, 144 + 5, 11, 6, 4, "#7d4b32");
    R(c, 144 + 5, 10, 6, 1, "#8a5638");
    R(c, 144 + 3, 4, 10, 8, "#3f7d55");
    R(c, 144 + 5, 2, 6, 5, "#4f9268");
    R(c, 144 + 7, 1, 3, 3, "#5aa87a");
    R(c, 144 + 6, 6, 1, 3, "#356645");
    A.plant = [144, 0, 16, 16];

    // water cooler
    R(c, 160 + 5, 3, 6, 11, "#8a929e");
    R(c, 160 + 5, 3, 6, 1, "#a9b2bd");
    R(c, 160 + 6, 1, 4, 3, "#bcd7ea");
    R(c, 160 + 6, 9, 4, 2, "#5b6270");
    A.water = [160, 0, 16, 16];

    // table piece (tileable middle)
    R(c, 176, 2, 16, 12, "#6b4d37");
    R(c, 176, 2, 16, 1, "#7d5b41");
    R(c, 176, 13, 16, 1, "#513a29");
    R(c, 179, 6, 10, 1, "#5f4531");
    A.table = [176, 2, 16, 12];

    // soft round shadow blob
    const g = c.createRadialGradient(200, 8, 1, 200, 8, 8);
    g.addColorStop(0, "rgba(0,0,0,0.34)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(192, 0, 16, 16);
    A.shadow = [192, 0, 16, 16];

    return cv;
  }

  /* ---------- per-agent character sheet ---------- */
  // 5 cols: idle, walkA, walkB, sit, type   |   3 rows: down, up, side
  const CW = 20, CH = 28;
  const COL = { idle: 0, walkA: 1, walkB: 2, sit: 3, type: 4 };
  const ROW = { down: 0, up: 1, side: 2 };

  function buildCharSheet(pal) {
    const { cv, c } = makeCanvas(CW * 5, CH * 3);
    for (const dir of ["down", "up", "side"]) {
      for (const st of ["idle", "walkA", "walkB", "sit", "type"]) {
        drawFrame(c, COL[st] * CW, ROW[dir] * CH, dir, st, pal);
      }
    }
    return cv;
  }

  // one 20x28 frame, feet near the bottom
  function drawFrame(c, ox, oy, dir, st, pal) {
    const p = (x, y, w, h, col) => R(c, ox + x, oy + y, w, h, col);
    const side = dir === "side";
    const back = dir === "up";
    const sitting = st === "sit" || st === "type";
    const step = st === "walkA" ? 1 : st === "walkB" ? -1 : 0;

    // legs / seat
    if (sitting) {
      p(6, 19, 8, 4, "#2b2f3a"); // chair seat edge
      p(6, 15, 3, 6, pal.pants);
      p(11, 15, 3, 6, pal.pants);
    } else {
      p(6, 18 + Math.max(0, step), 3, 6 - Math.abs(step), pal.pants);
      p(11, 18 - Math.max(0, step), 3, 6 - Math.abs(step), pal.pants);
      p(6, 24 + Math.max(0, step), 3, 2, pal.shoes);
      p(11, 24 - Math.max(0, step), 3, 2, pal.shoes);
    }

    // torso
    p(5, 9, 10, 9, pal.line);
    p(6, 9, 8, 8, pal.shirt);
    p(6, 9, 8, 1, shade(pal.shirt, 16));
    p(6, 16, 8, 1, pal.shirtDk);
    if (!back) p(9, 9, 2, 2, pal.shirtDk); // collar hint

    // arms
    if (st === "type") {
      p(4, 12, 3, 4, pal.shirt);
      p(13, 12, 3, 4, pal.shirt);
      p(4, 15, 2, 2, pal.skin);
      p(14, 15, 2, 2, pal.skin);
    } else if (side) {
      p(9, 11, 3, 5 + step, pal.shirt);
      p(10, 15 + step, 2, 2, pal.skin);
    } else {
      p(3, 11, 2, 5 + step, pal.shirt);
      p(15, 11, 2, 5 - step, pal.shirt);
      p(3, 15 + step, 2, 2, pal.skin);
      p(15, 15 - step, 2, 2, pal.skin);
    }

    // head
    p(6, 2, 8, 8, pal.line);
    p(7, 3, 6, 6, pal.skin);
    p(7, 3, 6, 1, shade(pal.skin, 12));
    p(7, 8, 6, 1, pal.skinDk);
    // hair
    p(6, 1, 8, 3, pal.hair);
    p(6, 1, 8, 1, shade(pal.hair, 18));
    if (back) {
      p(6, 1, 8, 8, pal.hair);
      p(6, 1, 8, 1, shade(pal.hair, 18));
    } else if (side) {
      p(6, 1, 4, 6, pal.hair);
      p(11, 5, 2, 2, pal.line); // eye
    } else {
      p(6, 1, 2, 5, pal.hair);
      p(12, 1, 2, 5, pal.hair);
      p(8, 5, 1, 2, pal.line);
      p(11, 5, 1, 2, pal.line);
    }
  }

  /* ---------- grid + pathfinding ---------- */

  const grid = MAP.map((r) => r.split(""));
  function solidAt(cc, rr) {
    if (cc < 0 || rr < 0 || cc >= COLS || rr >= ROWS) return true;
    const ch = grid[rr][cc];
    if (SOLID.has(ch)) return true;
    if (cc >= TABLE.c0 && cc <= TABLE.c1 && rr >= TABLE.r0 && rr <= TABLE.r1) return true;
    if (cc === WATER.c && rr === WATER.r) return true;
    for (const pl of PLANTS) if (pl.c === cc && pl.r === rr) return true;
    for (const s of LIBRARY_SHELVES) if (s.c === cc && s.r === rr) return true;
    for (const k in DESKS) if (DESKS[k].deskC === cc && DESKS[k].deskR === rr) return true;
    return false;
  }
  function walkable(cc, rr) {
    if (cc < 0 || rr < 0 || cc >= COLS || rr >= ROWS) return false;
    return WALK.has(grid[rr][cc]) && !solidAt(cc, rr);
  }

  /** 4-bit N/E/S/W mask of neighbours matching `glyphs` (outside the map = no). */
  function tileMask(cc, rr, glyphs) {
    const same = (c2, r2) =>
      c2 >= 0 && r2 >= 0 && c2 < COLS && r2 < ROWS && glyphs.has(grid[r2][c2]) ? 1 : 0;
    return (
      same(cc, rr - 1) | (same(cc + 1, rr) << 1) | (same(cc, rr + 1) << 2) | (same(cc - 1, rr) << 3)
    );
  }
  const WALL_GLYPHS = new Set(["#", "w"]);
  const CARPET_GLYPHS = new Set(["m"]);
  function bfs(start, goal) {
    if (start.c === goal.c && start.r === goal.r) return [];
    const key = (c, r) => c + "," + r;
    const q = [start];
    const prev = new Map([[key(start.c, start.r), null]]);
    while (q.length) {
      const cur = q.shift();
      if (cur.c === goal.c && cur.r === goal.r) {
        const path = [];
        let node = cur;
        let k = key(node.c, node.r);
        while (node) {
          path.unshift(node);
          const pr = prev.get(k);
          if (!pr) break;
          node = pr;
          k = key(pr.c, pr.r);
        }
        return path.slice(1);
      }
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = cur.c + dc, nr = cur.r + dr, k = key(nc, nr);
        if (prev.has(k)) continue;
        if (!walkable(nc, nr) && !(nc === goal.c && nr === goal.r)) continue;
        prev.set(k, cur);
        q.push({ c: nc, r: nr });
      }
    }
    return [];
  }
  const cx = (c) => c * PX + PX / 2;
  const cy = (r) => r * PX + PX / 2;

  /* ---------- overlays ---------- */

  function wrap(ctx, text, maxW) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > maxW && line) {
        lines.push(line);
        line = w;
      } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }
  function bubble(ctx, x, y, text) {
    ctx.font = "11px ui-monospace, monospace";
    const lines = wrap(ctx, text, 168).slice(0, 4);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
    const h = lines.length * 14 + 10;
    let bx = Math.max(4, Math.min(COLS * PX - w - 4, x - w / 2));
    const by = Math.max(4, y - h);
    R(ctx, bx, by, w, h, "#1c1f27");
    ctx.strokeStyle = "#2c313c";
    ctx.strokeRect((bx | 0) + 0.5, (by | 0) + 0.5, w | 0, h | 0);
    R(ctx, x - 3, by + h, 6, 5, "#1c1f27");
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    lines.forEach((l, i) => ctx.fillText(l, bx + 7, by + 15 + i * 14));
  }
  function tag(ctx, x, y, text, color) {
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    const w = ctx.measureText(text).width + 8;
    R(ctx, x - w / 2, y - 10, w, 13, "rgba(13,14,18,0.66)");
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  const BOARD_BUCKET = {
    queued: 0, active: 1, reviewing: 1, revision: 1, failed: 1, done: 2,
  };

  /** the kanban whiteboard on the bottom wall */
  function drawBoard(ctx, tasks, agents, now) {
    const x = BOARD.c0 * PX + SCALE;
    const w = BOARD.cols * PX - SCALE * 2;
    const y = ROWS * PX - SCALE * 11;
    const h = SCALE * 10;
    R(ctx, x - SCALE, y - SCALE, w + SCALE * 2, h + SCALE * 2, "#3a3f4a"); // frame
    R(ctx, x, y, w, h, "#e9e6da"); // board
    const colW = w / 3;
    const labels = ["TO DO", "DOING", "DONE"];
    ctx.font = "7px ui-monospace, monospace";
    ctx.textAlign = "center";
    for (let i = 0; i < 3; i++) {
      if (i) R(ctx, x + i * colW, y + SCALE, 1, h - SCALE * 2, "#b6b0a0");
      ctx.fillStyle = "#6b6552";
      ctx.fillText(labels[i], x + i * colW + colW / 2, y + SCALE + 4);
    }
    const counts = [0, 0, 0];
    for (const t of tasks.values()) {
      const col = BOARD_BUCKET[t.status] ?? 0;
      const row = counts[col]++;
      if (row > 3) continue;
      const cx0 = x + col * colW + 3;
      const cy0 = y + SCALE * 2.2 + row * (SCALE * 1.7);
      R(ctx, cx0, cy0, colW - 6, SCALE * 1.4, "#fbf8ee");
      R(ctx, cx0, cy0, SCALE, SCALE * 1.4, palFor(t.assignee).shirt); // assignee stripe
      if (t.status === "failed") R(ctx, cx0, cy0, colW - 6, 1, "#f87171");
      if (t.status === "revision")
        R(ctx, cx0 + colW - 6 - SCALE, cy0, SCALE, SCALE * 1.4, "#fbbf24");
    }
    const someoneAt = [...agents.values()].some((a) => a.boardUntil && now < a.boardUntil);
    tag(ctx, x + w / 2, y - SCALE * 2, "TASKS", someoneAt ? "#93c5fd" : DIM);
  }

  /* ---------- renderer ---------- */

  function OfficeRenderer(canvas) {
    canvas.width = COLS * PX;
    canvas.height = ROWS * PX;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    let atlas = buildTileAtlas();

    // Two ways to skin the tiles: /assets/office-tiles.png replaces the whole
    // atlas (our 16px cell layout); otherwise the bundled pixel-agents tiles are
    // painted cell-by-cell onto the baked atlas. Walls, the office-specific props
    // (monitor desks, water cooler) and every character stay procedural.

    // In-place HSL recolour of an atlas cell (one-time bake, not per frame).
    //   colorize (default): grayscale luminance → user hue+sat  (Photoshop style)
    //   adjust: rotate hue / shift sat, keep the source texture
    // color = { h, s, b, c, colorize? } — h deg, s/b/c in -100..100 (s 0..100
    // for colorize). b = brightness, c = contrast around mid-grey.
    function colorizeCell(actx, x, y, w, h, color) {
      const buf = actx.getImageData(x, y, w, h);
      const px = buf.data;
      const colorize = color.colorize !== false;
      const hue = color.h ?? 0, s = color.s ?? (colorize ? 100 : 0);
      const bAdj = (color.b ?? 0) / 200, cFac = (100 + (color.c ?? 0)) / 100;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        let H, S, L;
        if (colorize) {
          L = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
          H = hue;
          S = s / 100;
        } else {
          [H, S, L] = rgbHsl(px[i], px[i + 1], px[i + 2]);
          H = (((H + hue) % 360) + 360) % 360;
          S = Math.max(0, Math.min(1, S + s / 100));
        }
        if (color.c) L = 0.5 + (L - 0.5) * cFac;
        if (color.b) L += bAdj;
        L = Math.max(0, Math.min(1, L));
        const [r, g, b] = hslRgb(H, S, L);
        px[i] = r; px[i + 1] = g; px[i + 2] = b;
      }
      actx.putImageData(buf, x, y);
    }

    // Paint one source rect onto the baked atlas cell `name`, then optionally
    // HSL-recolour it in place (grayscale pixel-agents tiles → tan / blue / …).
    const paintTile = (actx, name, img, sx, sy, sw, sh, color) => {
      const d = A[name];
      if (!d) return;
      actx.clearRect(d[0], d[1], d[2], d[3]);
      actx.drawImage(img, sx, sy, sw, sh, d[0], d[1], d[2], d[3]);
      if (color) {
        try { colorizeCell(actx, d[0], d[1], d[2], d[3], color); } catch (_) { /* tainted */ }
      }
    };

    // A skin map is { base, tiles: { name: { file, sx, sy, sw, sh, color } } }.
    // Loads every image it needs, then paints. Skipped if a full override
    // (office-tiles.png) already replaced the atlas image.
    const applyMap = (map) => {
      const base = map.base || "";
      const srcs = new Set();
      for (const v of Object.values(map.tiles || {})) if (v && v.file) srcs.add(base + v.file);
      if (!srcs.size) return;
      const cache = {};
      let pending = srcs.size;
      const done = () => {
        const actx = atlas.getContext && atlas.getContext("2d");
        if (!actx) return; // a full override replaced the canvas
        actx.imageSmoothingEnabled = false;
        for (const [name, v] of Object.entries(map.tiles || {})) {
          const img = v && v.file && cache[base + v.file];
          if (img) {
            paintTile(actx, name, img,
              v.sx || 0, v.sy || 0, v.sw || 16, v.sh || 16, v.color);
          }
        }
      };
      for (const src of srcs) {
        const img = new Image();
        img.onload = () => { cache[src] = img; if (--pending === 0) done(); };
        img.onerror = () => { if (--pending === 0) done(); };
        img.src = src;
      }
    };

    // full replacement (wins outright: it swaps the atlas image itself)
    try {
      const img = new Image();
      img.onload = () => { atlas = img; };
      img.onerror = () => {};
      img.src = "/assets/office-tiles.png";
    } catch (_) {}

    // bundled default: pixel-agents (MIT). Grayscale floor / carpet tiles are
    // HSL-colorized (Photoshop style); the coloured sprites are used as-is.
    // See public/assets/pixel-agents/.
    applyMap({
      base: "/assets/pixel-agents/",
      tiles: {
        floor0: { file: "floor_0.png", color: { h: 35, s: 32, b: 6 } },
        floor1: { file: "floor_1.png", color: { h: 35, s: 32, b: -6 } },
        carpet: { file: "carpet_1.png", sx: 48, sy: 48, color: { h: 205, s: 26, b: -2, c: 8 } },
        chair: { file: "chair.png" },
        plant: { file: "plant.png", sy: 16 },
        table: { file: "table.png", sx: 16, sy: 8, sh: 12 },
      },
    });

    /* ---------- camera (zoom / pan / follow) ---------- */
    const WORLD_W = canvas.width, WORLD_H = canvas.height;
    const MIN_ZOOM = 1, MAX_ZOOM = 3.5;
    const cam = { zoom: 1, x: 0, y: 0, followId: null, drag: null };
    let lastAgents = null;

    function clampCam() {
      cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom));
      const vw = WORLD_W / cam.zoom, vh = WORLD_H / cam.zoom;
      cam.x = Math.max(0, Math.min(WORLD_W - vw, cam.x));
      cam.y = Math.max(0, Math.min(WORLD_H - vh, cam.y));
    }
    function toWorld(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const sx = (clientX - r.left) * (WORLD_W / r.width);
      const sy = (clientY - r.top) * (WORLD_H / r.height);
      return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
    }
    function agentAt(wx, wy) {
      if (!lastAgents) return null;
      let hit = null, best = 22;
      for (const [id, a] of lastAgents) {
        if (a.px === undefined || a.leaving) continue;
        const d = Math.hypot(a.px - wx, a.py - wy - 18);
        if (d < best) { best = d; hit = id; }
      }
      return hit;
    }

    canvas.style.cursor = "grab";
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const w = toWorld(e.clientX, e.clientY);
      cam.zoom *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
      clampCam();
      const r = canvas.getBoundingClientRect();
      cam.x = w.x - ((e.clientX - r.left) * (WORLD_W / r.width)) / cam.zoom;
      cam.y = w.y - ((e.clientY - r.top) * (WORLD_H / r.height)) / cam.zoom;
      cam.followId = null;
      clampCam();
    }, { passive: false });
    canvas.addEventListener("mousedown", (e) => {
      cam.drag = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y, moved: false };
      canvas.style.cursor = "grabbing";
    });
    window.addEventListener("mousemove", (e) => {
      if (!cam.drag) return;
      const r = canvas.getBoundingClientRect();
      const k = (WORLD_W / r.width) / cam.zoom;
      const dx = (e.clientX - cam.drag.x) * k, dy = (e.clientY - cam.drag.y) * k;
      if (Math.abs(dx) + Math.abs(dy) > 2) cam.drag.moved = true;
      cam.x = cam.drag.camX - dx;
      cam.y = cam.drag.camY - dy;
      cam.followId = null;
      clampCam();
    });
    window.addEventListener("mouseup", (e) => {
      if (!cam.drag) return;
      const wasDrag = cam.drag.moved;
      cam.drag = null;
      canvas.style.cursor = "grab";
      if (!wasDrag) {
        const w = toWorld(e.clientX, e.clientY);
        const id = agentAt(w.x, w.y);
        cam.followId = id && id === cam.followId ? null : id;
      }
    });
    canvas.addEventListener("dblclick", () => {
      cam.zoom = 1; cam.x = 0; cam.y = 0; cam.followId = null;
    });

    const blit = (key, dx, dy, dw, dh) => {
      const s = A[key];
      ctx.drawImage(atlas, s[0], s[1], s[2], s[3], dx, dy, dw ?? s[2] * SCALE, dh ?? s[3] * SCALE);
    };
    /** blit one raw atlas rect [sx,sy,sw,sh] scaled up (for the edge overlays) */
    const blitRect = (s, dx, dy) =>
      ctx.drawImage(atlas, s[0], s[1], s[2], s[3], dx, dy, s[2] * SCALE, s[3] * SCALE);

    function drawBackground(meetingLit) {
      R(ctx, 0, 0, canvas.width, canvas.height, "#0d0e12");
      for (let r = 0; r < ROWS; r++) {
        for (let cc = 0; cc < COLS; cc++) {
          const ch = grid[r][cc];
          const x = cc * PX, y = r * PX;
          if (ch === "#" || ch === "w") {
            blit(ch === "w" ? "wallInner" : "wall", x, y, PX, PX);
            blitRect(A.wallEdges[tileMask(cc, r, WALL_GLYPHS)], x, y);
          } else if (ch === "m") {
            blit("carpet", x, y, PX, PX);
            blitRect(A.carpetEdges[tileMask(cc, r, CARPET_GLYPHS)], x, y);
            if (meetingLit) R(ctx, x, y, PX, PX, "rgba(147,197,253,0.10)");
          } else if (ch === "d") blit("door", x, y, PX, PX);
          else blit((cc + r) % 2 ? "floor1" : "floor0", x, y, PX, PX);
        }
      }
    }

    /** faint wash + label around a role zone, only while someone works in it */
    function drawZones(ctx, agents) {
      const list = [...agents.values()];
      for (const z of ZONES) {
        if (!list.some((a) => z.desks.includes(a.desk) && !a.leaving)) continue;
        const x = z.c0 * PX, y = z.r0 * PX;
        const w = (z.c1 - z.c0 + 1) * PX, h = (z.r1 - z.r0 + 1) * PX;
        R(ctx, x, y, w, h, z.tint);
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.09)";
        ctx.setLineDash([SCALE * 2, SCALE * 2]);
        ctx.strokeRect(x + SCALE, y + SCALE, w - SCALE * 2, h - SCALE * 2);
        ctx.restore();
        tag(ctx, x + w / 2, y + 13, z.label, "rgba(198,208,224,0.5)");
      }
    }

    function ensure(a, id) {
      if (a.px !== undefined) return;
      a.sheet = buildCharSheet(palFor(id));
      a.col = DOOR.c;
      a.row = DOOR.r;
      a.px = cx(DOOR.c);
      a.py = cy(DOOR.r);
      a.facing = "up";
      a.path = [];
      a.animT = 0;
      a.moving = false;
      a.goalKey = "";
      a.onBreak = false;
      a.breakSlot = 0;
      a.libraryUntil = 0;
      a.librarySkill = "";
      a.libSlot = ((id.charCodeAt(0) || 0) % LIBRARY_TILES.length);
      a.boardUntil = 0;
      a.boardSlot = ((id.charCodeAt(0) || 1) % BOARD_TILES.length);
      a.wanderT = 0;
      a.wanderTarget = null;
      a.wanderMoves = 0;
      a.wanderCap = 2 + ((Math.random() * 3) | 0);
      a.restUntil = 0;
      a.currentTool = null;
      a.toolUntil = 0;
    }

    /** where an idle worker strolls when they have nothing to do — a few moves,
     *  then back to the desk for a sit-down rest, then off again */
    function wanderTile(a, now) {
      const d = DESKS[a.desk];
      if (a.restUntil && now < a.restUntil && d) {
        return { c: d.seatC, r: d.seatR, face: d.face };
      }
      if (!a.wanderT || now > a.wanderT) {
        a.wanderT = now + 3000 + Math.random() * 6000;
        if (d && ++a.wanderMoves >= a.wanderCap) {
          a.wanderMoves = 0;
          a.wanderCap = 2 + ((Math.random() * 3) | 0);
          a.restUntil = now + 6000 + Math.random() * 9000;
          a.wanderTarget = { c: d.seatC, r: d.seatR, face: d.face };
        } else if (Math.random() < 0.28) {
          a.wanderTarget = BREAK_TILES[(Math.random() * BREAK_TILES.length) | 0];
        } else if (Math.random() < 0.2) {
          a.wanderTarget = { c: WATER.c - 1, r: WATER.r };
        } else {
          let c, r, n = 0;
          do {
            c = 1 + ((Math.random() * (COLS - 2)) | 0);
            r = 1 + ((Math.random() * (ROWS - 2)) | 0);
          } while (!walkable(c, r) && ++n < 25);
          a.wanderTarget = { c, r };
        }
      }
      return a.wanderTarget || { c: DOOR.c, r: DOOR.r - 1 };
    }

    function goalTile(a, now) {
      if (a.leaving) return { c: DOOR.c, r: DOOR.r, face: "down" };
      if (a.boardUntil && now < a.boardUntil) {
        const t = BOARD_TILES[(a.boardSlot || 0) % BOARD_TILES.length];
        return { c: t.c, r: t.r, face: "down" };
      }
      if (a.onBreak) {
        const t = BREAK_TILES[(a.breakSlot || 0) % BREAK_TILES.length];
        return { c: t.c, r: t.r, face: "down" };
      }
      if (a.libraryUntil && now < a.libraryUntil) {
        const t = LIBRARY_TILES[(a.libSlot || 0) % LIBRARY_TILES.length];
        return { c: t.c, r: t.r, face: "right" };
      }
      if (a.meetingUntil && now < a.meetingUntil)
        return MEETING_SEATS[(a.meetingSlot || 0) % MEETING_SEATS.length];
      const d = DESKS[a.desk];
      // busy at a desk; the manager always has a desk; everyone else roams when idle
      if ((BUSY_STATES.includes(a.state) || a.role === "manager") && d) {
        a.wanderTarget = null;
        return { c: d.seatC, r: d.seatR, face: d.face };
      }
      return wanderTile(a, now);
    }

    function step(a, now, dt) {
      const goal = goalTile(a, now);
      const gk = goal.c + "," + goal.r;
      if (gk !== a.goalKey) {
        a.goalKey = gk;
        a.path = bfs({ c: a.col, r: a.row }, { c: goal.c, r: goal.r });
      }
      const speed = 3.4 * (dt / 16.7);
      if (a.path.length) {
        const nx = cx(a.path[0].c), ny = cy(a.path[0].r);
        const ddx = nx - a.px, ddy = ny - a.py;
        const dist = Math.hypot(ddx, ddy);
        a.facing =
          Math.abs(ddx) > Math.abs(ddy) ? (ddx < 0 ? "left" : "right") : ddy < 0 ? "up" : "down";
        if (dist <= speed) {
          a.px = nx; a.py = ny;
          a.col = a.path[0].c; a.row = a.path[0].r;
          a.path.shift();
        } else {
          a.px += (ddx / dist) * speed;
          a.py += (ddy / dist) * speed;
        }
        a.moving = true;
        a.animT += dt;
      } else {
        a.moving = false;
        if (goal.face) a.facing = goal.face;
      }
    }

    // tools that read / look things up → the calm "sit" pose; everything else
    // while working → the "type" pose
    const READ_TOOLS = /read|list|search|recall|fetch|find|browse|ask_|use_skill|review|get_/i;

    function frameFor(a, seated, now) {
      const dir = a.facing === "up" ? "up" : a.facing === "down" ? "down" : "side";
      let col;
      if (seated) {
        const toolActive = a.currentTool && now < (a.toolUntil || 0);
        if (a.state === "working") {
          col = toolActive && READ_TOOLS.test(a.currentTool) ? COL.sit : COL.type;
        } else {
          col = COL.sit;
        }
      } else if (a.moving) {
        col = Math.floor(a.animT / 140) % 2 ? COL.walkA : COL.walkB;
      } else {
        col = COL.idle;
      }
      return { sx: col * CW, sy: ROW[dir] * CH, flip: a.facing === "right" };
    }

    function drawAgent(ctx, a, id, now) {
      const seated =
        !a.moving &&
        !!DESKS[a.desk] &&
        a.col === DESKS[a.desk].seatC &&
        a.row === DESKS[a.desk].seatR &&
        ["working", "thinking", "idle", "done"].includes(a.state);
      const bob = a.moving ? -Math.abs(Math.sin(a.animT / 90)) * 2 : 0;
      const f = frameFor(a, seated, now);
      const w = CW * SCALE, h = CH * SCALE;
      const dx = Math.round(a.px - w / 2);
      const dy = Math.round(a.py - h + 6 * SCALE + bob);

      // shadow
      ctx.drawImage(atlas, A.shadow[0], A.shadow[1], 16, 16, a.px - 11 * SCALE / 2 - 6, a.py - 6, 22, 12);

      if (f.flip) {
        ctx.save();
        ctx.translate(dx + w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(a.sheet, f.sx, f.sy, CW, CH, 0, dy, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(a.sheet, f.sx, f.sy, CW, CH, dx, dy, w, h);
      }

      overlay(ctx, a, id, now);
    }

    function overlay(ctx, a, id, now) {
      const color = STATE_COLOR[a.state] || DIM;
      const headY = a.py - CH * SCALE + 4 * SCALE;

      if (a.state === "blocked") {
        ctx.beginPath();
        ctx.arc(a.px, a.py - 8 * SCALE, 16 + Math.sin(now / 150) * 3, 0, Math.PI * 2);
        ctx.strokeStyle = "#f87171";
        ctx.lineWidth = 2;
        ctx.stroke();
        tag(ctx, a.px, headY - 13, "needs approval", "#f87171");
      }
      tag(ctx, a.px, headY, id, INK);
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = color;
      ctx.fillText(a.state + (a.task ? " · " + String(a.task).slice(0, 16) : ""), a.px, a.py + 8);

      if (a.progress > 0 && a.state !== "done") {
        R(ctx, a.px - 18, a.py + 12, 36, 4, "#232833");
        R(ctx, a.px - 18, a.py + 12, 36 * Math.min(1, a.progress), 4, color);
      }
      if (a.state === "thinking" && !a.moving && !a.badge)
        tag(ctx, a.px + 13, headY + 2, "…", "#93c5fd");

      // persistent status badge (approval needed / waiting on the manager) —
      // stays until the event clears it, pulses so it reads as "needs you"
      if (a.badge) {
        ctx.save();
        ctx.globalAlpha = 0.6 + Math.sin(now / 240) * 0.4;
        tag(ctx, a.px + 14, headY - 2, a.badge.glyph, a.badge.color);
        ctx.restore();
      }

      // reading a skill: a little open book above the head + the skill name
      if (a.libraryUntil && now < a.libraryUntil) {
        const bx = a.px - 5 * SCALE;
        const by = headY - 7 * SCALE;
        R(ctx, bx, by, 10 * SCALE, 6 * SCALE, "#e8e0cf");
        R(ctx, bx + 5 * SCALE - 1, by, 2, 6 * SCALE, "#8a6a49");
        R(ctx, bx + SCALE, by + SCALE, 3 * SCALE, 1, "#8b93a3");
        R(ctx, bx + 6 * SCALE, by + SCALE, 3 * SCALE, 1, "#8b93a3");
        if (!a.moving) tag(ctx, a.px, by - 3, `📖 ${a.librarySkill}`, "#fbbf24");
      }

      if (a.bubble && now < a.bubbleUntil) bubble(ctx, a.px, headY - 6, a.bubble);
    }

    function deskGlowing(agents, deskId) {
      for (const a of agents.values())
        if (a.desk === deskId && a.state === "working" && !a.moving) return true;
      return false;
    }

    let last = 0;
    function draw(agents, tasks, now) {
      const dt = last ? Math.max(1, Math.min(48, now - last)) : 16;
      last = now;
      lastAgents = agents;

      let meetingLit = false;
      for (const a of agents.values())
        if (a.meetingUntil && now < a.meetingUntil) meetingLit = true;

      // ease the camera toward the followed agent
      if (cam.followId) {
        const a = agents.get(cam.followId);
        if (a && a.px !== undefined && !a.leaving) {
          const vw = WORLD_W / cam.zoom, vh = WORLD_H / cam.zoom;
          cam.x += (a.px - vw / 2 - cam.x) * 0.16;
          cam.y += (a.py - vh / 2 - cam.y) * 0.16;
        } else {
          cam.followId = null;
        }
      }
      clampCam();
      ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);
      ctx.imageSmoothingEnabled = false;

      drawBackground(meetingLit);
      drawZones(ctx, agents);

      // meeting table
      for (let cc = TABLE.c0; cc <= TABLE.c1; cc++)
        blit("table", cc * PX, TABLE.r0 * PX + SCALE * 2, PX, (TABLE.r1 - TABLE.r0 + 1) * PX - SCALE * 4);

      drawBoard(ctx, tasks || new Map(), agents, now);

      const items = [];
      for (const k in DESKS) {
        const d = DESKS[k];
        items.push({
          y: d.deskR * PX + PX,
          fn: () => {
            blit("chair", d.seatC * PX, d.seatR * PX, PX, PX);
            blit(d.face === "down" ? "deskDown" : "deskUp", d.deskC * PX, d.deskR * PX, PX, PX);
            if (deskGlowing(agents, k)) {
              ctx.save();
              ctx.globalAlpha = 0.16 + Math.sin(now / 220) * 0.05;
              R(ctx, d.deskC * PX - 6, d.deskR * PX - 4, PX + 12, PX, "#6ee7b7");
              ctx.restore();
            }
          },
        });
      }
      for (const pl of PLANTS)
        items.push({ y: pl.r * PX + PX, fn: () => blit("plant", pl.c * PX, pl.r * PX, PX, PX) });
      items.push({ y: WATER.r * PX + PX, fn: () => blit("water", WATER.c * PX, WATER.r * PX, PX, PX) });

      // break room: a rug + a snack machine, bottom-left
      const anyBreak = [...agents.values()].some((a) => a.onBreak);
      for (const t of BREAK_TILES) {
        const x = t.c * PX, y = t.r * PX;
        R(ctx, x + SCALE, y + SCALE, PX - SCALE * 2, PX - SCALE * 2, anyBreak ? "#3a3350" : "#2b2740");
        R(ctx, x + SCALE, y + SCALE, PX - SCALE * 2, SCALE, "#4a4468");
      }
      items.push({
        y: SNACK.r * PX + PX,
        fn: () => {
          const x = SNACK.c * PX, y = SNACK.r * PX;
          R(ctx, x + SCALE * 4, y + SCALE * 2, SCALE * 8, SCALE * 12, "#5a4a7a");
          R(ctx, x + SCALE * 5, y + SCALE * 3, SCALE * 5, SCALE * 6, "#1a1420");
          R(ctx, x + SCALE * 5, y + SCALE * 3, SCALE * 5, SCALE * 2, "#fbbf24");
          R(ctx, x + SCALE * 5, y + SCALE * 10, SCALE * 6, SCALE * 2, "#3a3350");
        },
      });

      // library: bookshelves along the right wall
      const SPINES = ["#b3543f", "#4f7db3", "#5fa06a", "#b5793a", "#8a6bb3", "#c9a24a"];
      for (const s of LIBRARY_SHELVES) {
        items.push({
          y: s.r * PX + PX,
          fn: () => {
            const x = s.c * PX, y = s.r * PX;
            R(ctx, x + SCALE, y + SCALE * 2, PX - SCALE * 2, PX - SCALE * 3, "#5c4530");
            for (let i = 0; i < 6; i++) {
              R(ctx, x + SCALE * 2 + i * SCALE * 2, y + SCALE * 3, SCALE * 1.6, SCALE * 4, SPINES[(i + s.r) % SPINES.length]);
              R(ctx, x + SCALE * 2 + i * SCALE * 2, y + SCALE * 8, SCALE * 1.6, SCALE * 4, SPINES[(i + s.r + 3) % SPINES.length]);
            }
            R(ctx, x + SCALE, y + SCALE * 7, PX - SCALE * 2, SCALE, "#5c4530");
          },
        });
      }

      for (const [id, a] of agents) {
        ensure(a, id);
        step(a, now, dt);
        // a dismissed agent walks to the door, then leaves
        if (a.leaving && a.col === DOOR.c && a.row === DOOR.r && !a.path.length) {
          agents.delete(id);
          continue;
        }
        items.push({
          y: a.py,
          fn: () => {
            if (id === cam.followId) {
              ctx.save();
              ctx.strokeStyle = "rgba(255,255,255,0.55)";
              ctx.setLineDash([3, 3]);
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.ellipse(a.px, a.py, 12, 6, 0, 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
            }
            drawAgent(ctx, a, id, now);
          },
        });
      }
      items.sort((p, q) => p.y - q.y);
      for (const it of items) it.fn();

      tag(ctx, cx((TABLE.c0 + TABLE.c1) / 2), 4 * PX + PX / 2 + 4, "MEETING", meetingLit ? "#93c5fd" : DIM);
      tag(ctx, cx(2.5), BREAK_TILES[0].r * PX - 2, "BREAK", anyBreak ? "#fbbf24" : DIM);
      const anyReading = [...agents.values()].some((a) => a.libraryUntil && now < a.libraryUntil);
      tag(ctx, cx(17.5), LIBRARY_SHELVES[0].r * PX - 2, "LIBRARY", anyReading ? "#93c5fd" : DIM);

      // ── back to screen space for overlays ──
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      const g = ctx.createRadialGradient(
        canvas.width / 2, canvas.height / 2, canvas.height * 0.32,
        canvas.width / 2, canvas.height / 2, canvas.height * 0.78,
      );
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.36)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (cam.zoom > 1.02 || cam.followId) {
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = "rgba(232,236,242,0.45)";
        const hint = cam.followId ? `following ${cam.followId}` : "drag to pan";
        ctx.fillText(`${cam.zoom.toFixed(1)}×  ·  ${hint}  ·  dbl-click to reset`, 8, canvas.height - 8);
      }
    }

    return {
      draw,
      /** camera control for the host (e.g. click an agent in a panel) */
      follow: (id) => { cam.followId = id || null; },
    };
  }

  window.OfficeRenderer = OfficeRenderer;
})();
