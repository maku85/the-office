# pixel-agents assets

Environment tiles skinned from **[pixel-agents](https://github.com/pablodelucca/pixel-agents)**
by Pablo De Lucca — **MIT License** (see `LICENSE`). Copyright (c) 2026 Pablo De Lucca.

Files here (renamed, otherwise unmodified) from `webview-ui/public/assets/`:

| file | origin | used for |
|------|--------|----------|
| `floor_0.png`, `floor_1.png` | `floors/` (16×16 grayscale) | office floor — multiply-tinted warm tan in `render.js` |
| `carpet_1.png` | `carpets/carpet_1.png` (64×64, 4×4 marching-squares) | meeting-room rug — case 15 (solid), tinted blue |
| `chair.png` | `furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png` | desk / meeting chairs |
| `plant.png` | `furniture/PLANT_2/PLANT_2.png` (16×32) | floor plant — bottom 16×16 |
| `table.png` | `furniture/TABLE_FRONT/TABLE_FRONT.png` (48×64) | meeting table — surface slice |

Walls, desks (with monitor), the water cooler and every character stay
procedural — pixel-agents' richer pieces (autotiled walls, multi-tile desks +
animated PC, whiteboard, 7-frame character sheets) would need renderer changes.

pixel-agents' own character sprites are *based on* **[JIK-A-4 "MetroCity"](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)**
(CC0) — noted here for completeness; we do not bundle the characters.
