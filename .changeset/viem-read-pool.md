---
"moesi": minor
"@moesi/oaath": minor
"@moesi/cli": minor
---

Add `createViemObserver` in `moesi/viem`: configure URL pools instead of writing
RPC failover, timeout, concurrency, and block-pin code. Reads retry only allowed
failure categories and preserve the exact canonical block hash and caller.
Use `batch: true` for JSON-RPC batching with caller semantics intact. Defaults
are three attempts, ten seconds per HTTP request, and eight concurrent reads.

`plan` and `verify` accept an `AbortSignal`. Each chain captures its snapshot
immediately before its reads; optional `{ lagBlocks }` selects a fresh lagged
pin. Same-stage checks run concurrently, retaining the first unreadable result
in canonical order. Cancellation never becomes a missing or drifted resource.

Unreadable cells and snapshot errors preserve bounded structured causes:
endpoint index, failure category, HTTP status, and RPC code. Raw provider errors,
messages, abort reasons, and credential-bearing endpoint URLs are excluded.

Breaking persisted formats: reviewed plans and deployment runs advance to v6,
verification and run results to v3, and CLI plan/execution-review/run-result
wrappers to v5. CLI error output advances to v2 to include safe causes. The
manifest remains v5. Recreate old artifacts.
