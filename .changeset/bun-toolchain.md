---
"moesi": patch
"@moesi/oaath": patch
"@moesi/cli": patch
---

Migrate repository installs, workspace commands, packing, and CI to Bun 1.4.2.
Use `bun install --frozen-lockfile --ignore-scripts` and `bun run check` when
contributing. The published libraries and CLI retain their Node >=22.13 runtime
support; Bun is required only for repository development.
