---
"moesi": patch
---

Reduce planning and convergence-verification latency by observing up to eight
independent resources concurrently while preserving deterministic plan IDs,
reviewed call order, per-resource check stages, and fresh per-chain snapshots.

Reduce RPC volume by sharing only overlapping endpoint identity checks with the
same cancellation signal. Settled identities are never cached; failover checks
each endpoint and ancestry verification always finishes with a fresh identity
request. Read workers stop scheduling new work after a failure.

Add a network-free observation benchmark reporting latency and RPC/HTTP counts.
