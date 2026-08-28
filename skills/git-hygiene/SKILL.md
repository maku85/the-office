---
name: git-hygiene
description: Clean commits and a readable history (needs shell access)
roles: [developer, devops]
keywords: [git, commit, branch, version control, pr, changelog]
---
# Git hygiene

Only useful when run_shell is enabled. Distilled from common practice.

- **One logical change per commit.** Don't mix a rename or a reformat with a fix.
- **Message:** imperative subject ≤ 50 chars ("Add retry to fetch"), a blank
  line, then *why* in the body when it isn't obvious. Not "fixes" / "wip".
- **Look before you commit:** `git status` and `git diff --staged` every time —
  know exactly what you are recording.
- **Stage paths, not `git add -A`.** Add the files you actually changed.
- **Never commit:** secrets, `.env`, build output, `node_modules`, editor and OS
  cruft — put them in `.gitignore`.
- **Branch per goal / feature.** Don't commit straight to `main`.
- **Before finishing:** `git log --oneline` should read as a sensible story of
  what happened.
