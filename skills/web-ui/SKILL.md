---
name: web-ui
description: Making a web UI look deliberate — layout, type, colour, spacing, states
roles: [designer, developer]
keywords: [ui, ux, css, layout, design, frontend, styling, visual]
---
# Web UI that looks deliberate

Distilled from common web-UI practice. Keep it simple; restraint reads as polish.

## Layout
- One clear visual hierarchy per screen: a primary element, everything else quieter.
- Generous whitespace. Text column max ~70 characters — don't full-width prose.
- Align to a rhythm; don't centre everything by default.

## Type
- 2 sizes + 1 weight step is usually enough. Body 14–16px, line-height ~1.5.
- One typeface (a good system stack is fine). No decorative fonts for UI text.

## Colour
- One accent colour. Neutral greys for the rest.
- Body text must hit **4.5:1** contrast against its background; large text 3:1.
- Don't signal state with colour alone (add an icon or text).

## Spacing scale
Pick every gap/padding from `4 8 12 16 24 32 48`. Never free-hand pixel values.

## States (the parts people forget)
- Every interactive element: default, **hover**, **focus-visible**, **disabled**.
- Every data view: **loading**, **empty**, **error** — never a bare blank area.
- Forms: inline validation, a real `<label>`, and a visible focus ring.

## Motion
Short (150–200ms), only on a state change, and honour `prefers-reduced-motion`.

## Before you finish — check
- [ ] one hierarchy, whitespace, ≤70ch text
- [ ] spacing from the scale
- [ ] hover + focus-visible + disabled on controls
- [ ] loading / empty / error states exist
- [ ] text contrast ≥ 4.5:1
