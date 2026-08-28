---
name: mobile-app
description: Mobile app deliverables when there is no device toolchain here
roles: [developer, designer]
keywords: [mobile, ios, android, app, react-native, expo, flutter]
---
# Mobile app (no build/run toolchain in this office)

We cannot compile or run a real iOS/Android project. Deliver something a
developer with the toolchain can pick up:

- `SPEC.md` + `DESIGN.md` as usual: screen list, navigation graph, per-screen
  state, empty/error/loading states.
- **Framework choice, stated and justified.** Default: React Native + Expo
  (TypeScript). Flutter is fine if the goal implies it.
- The core screens as real source files under `src/` (e.g. `src/screens/*.tsx`,
  `src/navigation.tsx`), small components, typed props.
- No native modules unless the goal requires one; if it does, note the exact
  package and the config step.
- `README.md` with the exact commands to scaffold, install and run
  (`npx create-expo-app`, `npm install`, `npx expo start`, or the Flutter
  equivalents).

## Before you finish — check
- [ ] every screen in DESIGN.md has a source file
- [ ] navigation between them is wired
- [ ] README lists runnable commands, in order
