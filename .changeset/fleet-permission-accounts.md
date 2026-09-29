---
"@moesi/oaath": minor
"@moesi/cli": patch
---

Compile one OAAth permission from heterogeneous fleet plans and map a manifest's
logical account name to an existing SDK account. Permission compilation and
requests now take `plans: [plan]` instead of `plan`; up to 32 distinct plans can
share one approval. The per-chain operation limit covers aggregate operations
across all supplied plans. An insufficient existing grant is retained and rejected
without requesting replacement permission.

Pass the same `account: { address, accountId }` to permission
requests and the execution provider. The CLI forwards this binding from the
caller-owned client module. The SDK's native identity remains bound into the
provider review. Account or authority changes invalidate execution acceptance.
