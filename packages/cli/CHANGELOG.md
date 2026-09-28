# @moesi/cli

## 0.14.0

### Minor Changes

- 1c640e6: Resolve explicit resource-address-word expressions and nonrecursive hex
  concatenation in configuration and attestation byte fields before observation.
  Reviewed plans retain only exact literal bytes; references never infer runtime
  dependencies or provider identity. Export source expression types and
  `ResolvedMoesiManifest` for canonical literal manifests.

  Recreate stale artifacts; unsupported versions are rejected before field
  diagnostics, with `unsupported_run_version` and
  `unsupported_plan_artifact_version` added for Run and CLI plan boundaries.
  There are no compatibility readers. Unknown resource IDs produce
  `unknown_reference`; malformed expression objects produce `invalid_reference`.

- 8e525b1: Add closed manifest `semanticChecks` for Ownable ownership, AccessControl membership/admin roles, and ERC-1967 direct/beacon proxy expectations. Planning compiles exact read-only assertions with explicit semantic kinds and call targets. The plan codec binds those assertions to the manifest; planning and fresh verification reject malformed ABI words as unreadable. These assertions produce no repair calls or authority. CLI review/inspection/verification show their kinds and targets.

  Breaking artifact change: manifest, reviewed-plan, and deployment-run versions are v4; CLI plan, execution-review, and run-result versions are v3; core verification-result and run-result versions are v2. Recreate stale artifacts and review again. No compatibility readers or in-place upgrades are provided.

- ad23cdc: Add `parseManifestText` for one bounded JSON or YAML 1.2 document, and allow
  `moesi plan --manifest -` to read stdin. Equivalent data produces the same
  immutable manifest and plan. Quote YAML addresses, bytes, and decimal values.

  Manifest text now rejects duplicate keys, aliases, anchors, explicit tags,
  multiple documents, excessive nesting, and input larger than 1 MiB of UTF-8.
  Malformed syntax uses `invalid_manifest_document`, replacing the CLI-only
  `manifest_json_invalid` code; oversized input uses `manifest_source_too_large`.

- bc960d2: Add explicit optional OAAth selection with a caller-owned SDK module, a separate
  authorize command, review-bound apply and reference-only recovery. Viem and
  read-only commands do not load or require the adapter. Close SDK resources on
  every command outcome without revoking permission.

  Atomicity identifies one transaction per viem action or one SDK operation per
  OAAth action. Recreate old review artifacts; final artifact versions for this
  release are listed with the semantic-check changes above.

- c6ea95f: Replace the old deployer APIs with the incompatible provider-neutral Moesi design, without compatibility shims or an OAAth implementation.

### Patch Changes

- Updated dependencies [f0f95e7]
- Updated dependencies [1c640e6]
- Updated dependencies [8e525b1]
- Updated dependencies [ad23cdc]
- Updated dependencies [35147c9]
- Updated dependencies [c6ea95f]
  - moesi@0.14.0
