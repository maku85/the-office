---
name: debug-methodically
description: A repeatable way to find a bug instead of guessing
roles: [developer, qa]
keywords: [debug, bug, error, broken, fix, crash, troubleshoot]
---
# Debug methodically

Distilled from common debugging practice.

1. **Reproduce first.** Write down the exact steps and the smallest input that
   triggers it. If you can't reproduce it, you can't fix it.
2. **Read the real error.** Open the actual message and stack trace. Find the
   first line that is *your* code. Don't theorise before you've read it.
3. **Bisect to isolate.** Binary-search: halve the input, comment out half the
   code, or `git bisect`. Get to the smallest failing case.
4. **One hypothesis at a time.** State what you think is wrong, change ONE thing,
   re-test. If it didn't help, revert it before trying the next.
5. **Check the boring causes first:** off-by-one, wrong type, `==` vs `===`,
   stale cache / wrong file, async ordering, mutated shared state, a typo in a
   key name, an unhandled empty array.
6. **Instrument at the boundary**, not scattershot. One targeted log or assert
   where the good value should still be true.
7. **When fixed:** add a test (or an assertion) that would have caught it, so it
   can't come back silently.
