---
"@moesi/cli": patch
---

Preserve authorization and execution outcomes when runtime cleanup fails. Apply,
resume, and authorize now report a scrubbed secondary warning on stderr instead
of replacing the original error or changing an already-rendered result's exit
code. JSON warnings use `moesi.cli-warning/v1` with `runtime_cleanup_failed`.
