# Optional sprite override

`render.js` bakes its tiles and characters procedurally at startup, so the office
works with nothing in here.

To use real art instead, drop **`office-tiles.png`** in this folder. It must
follow the same 16px cell layout the baked atlas uses (see `buildTileAtlas()` in
`render.js` — the `A.*` rects). On load it replaces the baked tile atlas;
characters stay procedural (they're recoloured per agent).
