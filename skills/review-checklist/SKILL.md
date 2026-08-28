---
name: review-checklist
description: How to review a build against SPEC.md before approving
roles: [qa]
keywords: [review, qa, verify, checklist, acceptance]
---
# Reviewing a build

1. **Open SPEC.md.** For EACH acceptance criterion, open the produced files and
   confirm it — quote the line or behaviour that satisfies it, or mark it
   **FAILED** with exactly what is missing. If there is no SPEC, check against the
   task text and the overall goal.
2. **Runtime traps for the medium:**
   - web / game: does the inline `<script>` parse? is there a `clearRect` / full
     redraw each frame? do all controls exist? does the game loop use a fixed
     timestep? does restart actually reset state?
   - script / CLI: empty or malformed input handled? non-zero exit on error?
   - data: are the numbers reproducible from the stated method?
3. **Structure:** files in the folder the SPEC/goal named (same `<name>` for the
   whole goal); one file if "one file" was asked.
4. **Verdict:**
   - `approve` only if every criterion passes.
   - otherwise `request_changes` with a NUMBERED list of exact fixes — enough for
     the developer to act without guessing.

Do not fix anything yourself.
