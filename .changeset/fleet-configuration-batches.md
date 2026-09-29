---
"moesi": minor
"@moesi/oaath": minor
"@moesi/cli": minor
---

Compile contiguous configuration rows into bounded calls containing only drifted,
ready rows. Preserve an exact postcondition for every row. Add literal cross-chain
peer prerequisites with pinned evidence, pending/blocked readiness, and fresh
runtime and lineage checks before submission and during convergence verification.
The CLI accepts read-only `--peer-chain` bindings and displays peer readiness.

Breaking persisted versions: manifest v6, reviewed plan v7, deployment run v7,
verification/run result v4, and CLI plan/execution-review/run-result wrappers v6.
Regenerate old artifacts. Steps now contain `configurationIds` arrays (empty for
deployments); reviewed plans require `peers` evidence, and plan disposition adds
`pending`. No previous-schema reader or in-place artifact migration is provided.
