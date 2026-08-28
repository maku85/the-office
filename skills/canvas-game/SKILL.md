---
name: canvas-game
description: Building a browser game on <canvas> — grid, loop, input, common bugs
roles: [developer, designer]
keywords: [game, canvas, snake, tetris, pong, breakout, arcade]
---
# Canvas game (one HTML file)

## Coordinates
Work in **grid cells**, not pixels. Store positions as `{c, r}` and multiply by
`CELL` only when drawing. `canvas.width = COLS*CELL`, `canvas.height = ROWS*CELL`.

## Game loop — fixed timestep (never tie speed to frame rate)
```js
let last = 0, acc = 0;
const STEP = 1000 / SPEED;      // SPEED = updates per SECOND
function frame(t) {
  acc += t - last; last = t;
  while (acc >= STEP) { update(); acc -= STEP; }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```
`update()` advances exactly one grid step. `render()` only draws.

## Rendering
First line of `render()`: `ctx.clearRect(0, 0, canvas.width, canvas.height)`.
Forgetting it is the #1 bug (pieces leave trails).

## Input
`keydown` sets a **pending** direction; apply it inside `update()`, not on the
event. Reject a direction that reverses the current one (prevents instant death /
double-turns within one step).

## Rotation (Tetris-style)
Rotate the shape **matrix**:
```js
const rot = shape[0].map((_, x) => shape.map(row => row[x]).reverse());
```
Do NOT index rows by a rotation counter. After rotating, test collision and
revert (or wall-kick ±1 column) if it fails.

## Correct tetromino set (rows of 0/1), one colour each
- I `[[1,1,1,1]]`
- O `[[1,1],[1,1]]`
- T `[[0,1,0],[1,1,1]]`
- S `[[0,1,1],[1,1,0]]`
- Z `[[1,1,0],[0,1,1]]`
- J `[[1,0,0],[1,1,1]]`
- L `[[0,0,1],[1,1,1]]`

## Before you finish — check
- [ ] positions in cells, drawn ×CELL
- [ ] fixed-timestep loop; `clearRect` every `render()`
- [ ] pending-direction input; no self-reversal
- [ ] score updates on the right event (eat / line clear)
- [ ] game-over overlay + a restart key that calls the single `reset()`
