# Changelog

## 0.15.3

All three public packages release together as `0.15.3`. This pre-1.0 patch
contains breaking API and persisted-artifact changes:

- Replace the runtime viem integration with published `cetane@0.0.3`. Import
  from `moesi/cetane`, use the `createCetane*` APIs, and select `--provider cetane`
  for ordinary CLI execution. The old viem subpath and provider names are removed.
  Create new provider reviews; unresolved viem Runs must be observed with the
  release that created them, never resent through a newly selected provider.
- Add account-module expectations, state-confirmed authority drift, explicit
  reviewed removal calls and fresh verification. History counts and incomplete
  contextual coverage remain separate from confirmed state.
- Recreate older artifacts: manifest v7, reviewed plan v8, verification v5,
  run result v8, deployment run v10, fleet observation v3, CLI execution review
  v9 and CLI run result v10. There are no compatibility readers.
- Add safe/finalized snapshot policies and caller-owned RPC budgets. Reduce
  observation latency through bounded concurrency and RPC volume through
  in-flight identity-check sharing, without caching settled evidence.
- Require sibling Moesi packages at least `0.15.3`. The OAAth adapter continues
  to require the published `@oaath/sdk@0.3.0` contract.

## 0.15.0

The first published release of the rebuilt Moesi. `0.14.0` was prepared but
never published; its notes below still describe the rebuild. Changes since then,
with details in each package's changelog:

- `@moesi/oaath` requires the published `@oaath/sdk@0.3.0` and reads reviews
  through its versioned `oaath-calls-review-v1` contract. Account implementation
  and submission route are opaque identity bound into review, so a new Kernel
  version or route needs no adapter release. Kernel v3.3 and v4 accounts are
  both covered.
- Breaking: the adapter's `sender` option is removed. Submission routing is
  OAAth's; pass an optional `payer` in the SDK's own shape. The handleOps
  fallback needs `payer: { kind: "connected-eoa", wallet }`. The account binding
  is `{ address, accountId? }`, and unknown provider options are rejected.
- Independent session runs use an optional caller-reserved `lane`. Operation
  references are `oaath-op-v3`; older references are unsupported.
- `resume({ mode: "observe-only" })` and `moesi resume --observe-only` confirm
  existing work without starting untouched work.
- Typed fleet authoring (`moesi/fleet`), durable fleet observations and parity,
  compiler artifact inputs, deployment recipes, owner execution, and a Bun
  toolchain.
- Releases run through Changesets (`release:version`, `release:publish`).
  Sibling peer ranges are open within 0.x (`>=0.15.0 <1.0.0`).

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
