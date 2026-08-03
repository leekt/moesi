# AGENTS.md

These are Moesi's authoritative repository-specific rules. Other documents may
point here but must not redefine them.

## Product boundary

- Moesi is onchain Terraform: observe pinned state, detect drift, create a
  deterministic reviewed plan, execute it through OGP, and verify convergence.
- Moesi owns manifests, observation, drift, deployment planning and calldata,
  reviewed calls, deployment postconditions, semantic verification, Runs, the
  CLI, and deployment-focused UI.
- OGP owns credentials, grants, permission installation, operation identity and
  journals, signing, submission routing, relay state, and device approval.
- OGP never depends on Moesi. Moesi consumes a released `@leekt/ogp@0.x.y` or
  an exact local tarball, never a git dependency, submodule, or cross-repository
  workspace/source import.

## Compatibility and releases

- Use `pnpm` and repository-owned scripts.
- All releases remain `0.x.y` until a separate explicit 1.0 decision.
- Before 1.0, backward compatibility is explicitly out of scope.
- Do not preserve old APIs, packages, schemas, databases, or artifacts from
  `leekt/deployer`.
- Delete obsolete readers, writers, aliases, wrappers, forwarding packages,
  fallback branches, compatibility barrels, in-place upgrade helpers, and
  compatibility-only tests instead of recreating them.
- Persisted schemas and review artifacts still require one explicit current
  version. Old persisted state may be rejected and recreated.
- Breaking changes require release notes, not compatibility code.

## Architecture

- Initial public packages are only `moesi` and `@moesi/cli`.
- Do not recreate the old workspace package fan-out, `MoesiPresetTypes`,
  type-only preset anchors, generic client-extension composition, or custom
  dist copying/import rewriting.
- Do not build a generic account/provider framework without a second real
  implementation.
- `ReviewedPlan` is immutable and owns both the exact executable calls and the
  canonical policy compiled into the OGP all-chain permission request.
- OGP operation verification and Moesi deployment/convergence verification are
  separate evidence boundaries. Never treat one as proof of the other.
- Machine decisions use structured codes and discriminants, never diagnostic
  prose.

## Scope and evidence

- One non-trivial PR proves one primary outcome or invariant.
- Start with the type, codec, state machine, or store that owns the invariant.
- Validate caller, file, RPC, OGP, and durable-state inputs once at their trust
  boundary into exact immutable representations.
- Use focused tests plus lint, typecheck, and build for ordinary changes. Use a
  packed clean consumer for public API claims and local RPC paths for onchain
  behavior claims.
- Automated tests must not contact paid or shared RPCs by default.
- Never log or retain private keys, signatures, session material, bearer
  tokens, approval artifacts, credential-bearing URLs, raw request bodies, or
  raw provider errors.
