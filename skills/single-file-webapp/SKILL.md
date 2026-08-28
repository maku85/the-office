---
name: single-file-webapp
description: One self-contained HTML file — structure, inline CSS/JS, no build step
roles: [developer]
keywords: [html, web, page, spa, widget, tool, calculator, form]
---
# Single-file web app

- **One file.** `<style>` in `<head>`; `<script>` at the END of `<body>` (DOM
  already parsed) or wrap the code in `DOMContentLoaded`.
- **No external requests**: no CDN `<script>`/`<link>`, no web fonts, no `fetch`
  to other hosts. Vanilla JS unless the goal says otherwise.
- Cache DOM references once at the top of the script, not inside handlers.
- Keep all state in plain variables or one object; a single `render()` reflects
  state → DOM. Don't scatter DOM writes through the logic.
- Events: keyboard on `document`; buttons via `addEventListener` (no inline
  `onclick=` — keep JS in the script block).
- Persistence: `localStorage` wrapped in `try/catch` (private windows throw); the
  page must still work with nothing stored.
- Responsive: `max-width: 100%` on media; no fixed pixel width on `<body>`.
- Accessibility basics: `<label>` for inputs, visible focus, real button elements.

## Before you finish — check
- [ ] the `<script>` parses with no syntax error
- [ ] the page does something visible on load
- [ ] every feature in the SPEC / goal is wired to a control
- [ ] no console errors on a fresh load
