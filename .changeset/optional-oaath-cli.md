---
"@moesi/cli": minor
---

Add explicit optional OAAth selection with a caller-owned SDK module, a separate
authorize command, review-bound apply and reference-only recovery. Viem and
read-only commands do not load or require the adapter. Close SDK resources on
every command outcome without revoking permission.

CLI execution-review and run-result artifacts are now v2. Atomicity identifies
one transaction per viem action or one SDK operation per OAAth action. Recreate
old review artifacts; no compatibility reader is provided.
