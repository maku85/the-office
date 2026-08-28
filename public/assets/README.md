# Sprite overrides

`render.js` bakes its tiles and characters procedurally at startup, then skins
some tiles from image assets if available. Walls, the office-specific props
(monitor desks, water cooler) and every character always stay procedural.

## `pixel-agents/` — bundled default (MIT)

Tiles skinned from [pixel-agents](https://github.com/pablodelucca/pixel-agents)
by Pablo De Lucca (MIT — see `pixel-agents/LICENSE` and `CREDITS.md`). `render.js`
paints these onto the baked atlas: floors (grayscale, HSL-colorized warm tan —
Photoshop "Colorize"), the meeting-room rug (`carpet_1.png` marching-squares case
15, colorized blue), the chair, a floor plant, the meeting table. Delete the
folder for fully-baked.

The skin map lives inline in `render.js` (`applyMap({ base: "/assets/pixel-agents/", … })`);
each entry is `{ file, sx, sy, sw, sh, color }` — a source rect painted into the
atlas cell of the same name, then optionally HSL-recoloured. `color = { h, s, b,
c, colorize? }`: `colorize` (default) maps grayscale luminance to `h`/`s`;
otherwise the hue is rotated and saturation shifted, keeping the texture. `b` =
brightness, `c` = contrast (both −100…100).

## `office-tiles.png` — full atlas replacement (optional)

Drop **`office-tiles.png`** here to replace the baked tile atlas wholesale. Same
16px cell layout as `buildTileAtlas()` in `render.js` (the `A.*` rects). Takes
precedence over the bundled tiles. Characters still stay procedural.
