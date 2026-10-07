---
"moesi": minor
---

Add per-chain `safe` and `finalized` snapshot policies to `createCetaneObserver`.
Capture the selected header and retain its exact canonical block hash through
code, call and storage reads. Unsupported or malformed tag responses fail
closed; failover never substitutes a different policy.
