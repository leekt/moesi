---
"moesi": minor
---

Add versioned durable fleet observations with pinned compiler reads, retained
complete evidence during failures, explicit partial observations, cancellation,
and revision-based publication that prevents stale scan completion. Export the
store contract, memory store and per-chain scanner from `moesi/fleet`, and the
Node SQLite store from `moesi/node`. Old observation formats are not migrated.
