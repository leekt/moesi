# Changelog

## 0.14.0

Moesi is rebuilt as provider-neutral onchain Terraform: pinned observation,
drift, deterministic reviewed plans, explicit provider review, durable execution
and independent deployment verification. This is a breaking pre-1.0 replacement;
old APIs, presets, packages and persisted artifacts are unsupported.

- Core supports managed and external resources, bounded JSON/YAML input,
  explicit address references, runtime dependencies, pinned discovery and
  owner/role/ERC-1967 checks. Deployment strategies include the canonical
  CREATE2 factory, sender-protected and explicitly unguarded CreateX CREATE2,
  explicitly unguarded CreateX CREATE3, and a checked beacon family.
- Immutable plans own exact calls and provider-neutral sender/enforcement
  requirements. One explicitly reviewed provider is bound to each Run.
- `moesi/viem` submits ordinary caller-owned wallet transactions and blocks
  unsupported sender or onchain-enforcement requirements before signing.
- Optional `@moesi/oaath` consumes the public `@oaath/sdk@0.2.0` contract for one
  all-chain Grant, actual provider review, exact execution and operation-ID
  recovery. Moesi contains no OAAth implementation.
- Runs retain possible-submission fences and provider references. Recovery
  observes submitted work without blind retries; both provider paths have
  packed CLI process-recreation proofs and independent convergence checks.
- The CLI supports plan, inspect, verify, explicit provider apply/resume and
  offline status. OAAth consent is a separate `authorize` action. Four runnable
  examples cover viem, OAAth, multichain OAAth and drift repair.

Current artifact versions are manifest/reviewed-plan/deployment-run v4;
CLI plan/execution-review/run-result v3; core verification-result/run-result v2.
Recreate stale artifacts and review them again. No migration or compatibility
reader is included.

All three Moesi packages use `0.14.0`; existing registry `0.13.0` is not replaced.
The OAAth dependency is an exact reviewed `0.2.0` tarball group with provenance.
Source versioning is complete separately from any manual npm publication.

Package notes: [moesi](packages/moesi/CHANGELOG.md),
[@moesi/oaath](packages/oaath-adapter/CHANGELOG.md),
[@moesi/cli](packages/cli/CHANGELOG.md).
