---
"moesi": minor
"@moesi/cli": minor
---

Resolve explicit resource-address-word expressions and nonrecursive hex
concatenation in configuration and attestation byte fields before observation.
Reviewed plans retain only exact literal bytes; references never infer runtime
dependencies or provider identity. Export source expression types and
`ResolvedMoesiManifest` for canonical literal manifests.

The current manifest, reviewed-plan, and deployment-run schemas are v3. The CLI
plan wrapper is v2. Recreate stale artifacts; unsupported versions are rejected
before field diagnostics, with `unsupported_run_version` and
`unsupported_plan_artifact_version` added for Run and CLI plan boundaries.
There are no compatibility readers. Unknown resource IDs produce
`unknown_reference`; malformed expression objects produce `invalid_reference`.
