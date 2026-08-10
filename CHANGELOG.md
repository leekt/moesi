# Changelog

## Unreleased

### Changed

- Applying a plan now requires a caller-owned `DeploymentRunStore` so Moesi can
  persist a possible-submission fence before invoking the selected provider.
- Deployment runs use the current `moesi.deployment-run/v1` record and can be
  reconstructed with `moesi.resume({ runId, provider })`. Recovery observes
  retained provider references without resubmission, blocks ambiguous fences,
  and can continue only provably untouched pending work after exact preflight.
- `DeploymentRun.runId` is the reviewed plan ID. A run store admits one durable
  execution lifetime per exact plan; retries after terminal state and provider
  changes require fresh observation and planning.
- `@moesi/cli` now includes a process-safe append-only local run store and
  `moesi status --run <id> --store <directory>`. Status reads execution state
  without RPC/provider access and never infers semantic convergence.
- `@moesi/cli` now executes through an explicitly selected direct viem provider.
  Apply uses a two-pass exact review ID, environment-name signer bindings, and
  the durable local store; resume reconstructs the exact run and observes
  retained references without resubmission.
- Direct viem reviews and opaque references now bind the exact confirmation
  policy. Malformed wallet transaction identities remain behind the ambiguous
  submission fence instead of becoming durable submitted references.
- Deployment runs expose cooperative safe-stop handling. Existing durable
  progress and provider references remain visible, including when recovery is
  stopped before new work.
- Missing configured contracts now plan deployment and configuration as one
  canonical ordered run, with all same-chain deployments first. Configuration
  cannot cross its durable submission fence until fresh pinned evidence verifies
  its target runtime, every new deployment runtime, and chain lineage.
- `create2-factory-v1` is now closed over the canonical Arachnid deterministic
  deployment proxy. Manifests no longer select a factory; reviewed plans retain
  pinned capability evidence, and every deploy reattests the exact proxy runtime
  and chain lineage before persisting its possible-submission fence.
- Managed resources can also select the closed `createx-create2-v1` strategy.
  It uses the canonical CreateX factory, an exact 11-byte entropy, and a reviewed
  owner EOA to derive sender-protected CREATE2 salt, address, calldata, and
  execution requirements. Capability evidence is keyed by chain and strategy,
  and the matching factory is reattested before submission; alternate guards,
  caller-supplied raw salts, CREATE3, and custom factories remain out of scope.
- Managed deployments now require canonical `requiresRuntime` resource IDs.
  Planning rejects invalid or cyclic edges, orders reachable missing managed
  prerequisites before dependents, and reattests every direct prerequisite at
  the same fresh pinned snapshot as the factory before opening a submission
  fence. Runtime-only prerequisites never imply configuration or external-check
  authority.
- Manifest resources now require an exact `managed` or `external`
  discriminant. External resources bind a literal address, runtime-code hash,
  literal 32-byte storage checks, and exact read-only calls with explicit
  simulation callers for pinned, verify-only observation. Raw storage accepts
  no aliases or coercion and is observed by exact block hash. External evidence
  never produces deployment capabilities, write calls, requirements, or
  provider authority, and nonconvergence blocks without fabricated remediation.
- Managed resources now accept the same literal read-only call and storage
  checks as external resources. Reviewed cells keep those attestations separate
  from repairable configuration: they can block convergence but never create a
  transaction, while mixed configuration drift remains partial and emits only
  its exact write calls.
- `createMoesi().verify({ plan })` and `moesi verify` now perform provider-free
  semantic re-observation against fresh pinned descendants of the reviewed plan.
  The versioned result distinguishes converged, drifted, and unreadable state;
  verification requires no signer or run store and does not treat provider
  finality as deployment proof.
- `moesi inspect --plan <path>` now validates and expands an exact saved plan
  without RPC, execution-provider, signer, environment, or Run-store access.
  JSON inspection reuses the canonical `moesi.cli-plan/v1` artifact rather than
  introducing another persisted schema.
- Public package manifests now track the published `0.12.0` baseline and one
  fixed-group minor Changeset predicts the incompatible `0.13.0` release for
  both `moesi` and `@moesi/cli`. Release checks also reject mismatched package
  versions, internal dependency drift, and unintended tarball contents.
- The local-RPC release gate now installs the packed `moesi` tarball into a
  clean consumer at the public Node floor and proves the public `moesi` and
  `moesi/viem` plan, review, submit, observe, fresh-verify, and converged-replan
  lifecycle through one exact sender-bound CreateX transaction without a
  retained private key.
