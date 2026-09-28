# Issue 456 acceptance evidence

This records the completed source and packed-artifact acceptance for
[leekt/deployer#456](https://github.com/leekt/deployer/issues/456), using the
Moesi `0.14.0` fixed group and exact OAAth `0.2.0` artifacts. It does not claim
npm publication, a release-candidate security review, or native/iOS validation.
The user explicitly excluded iOS.

## First-release criteria

| Criterion | Implementation and proof |
| --- | --- |
| Core has no OAAth dependency or imports | `pnpm check:boundaries`; `scripts/check-oaath-boundary.mjs`; direct packed consumers assert OAAth is absent. |
| ReviewedPlan is provider-neutral | `packages/moesi/src/planning/types.ts` and `reviewed-plan.test.ts`; immutable exact calls, sender and enforcement requirements. |
| Provider review is explicit, immutable and invalidated by change | `provider-contract.test.ts`, `viem-provider.test.ts`, adapter tests, and CLI review-ID tests. |
| Run stores provider identity/reference without lifecycle state | Current Run codec in `packages/moesi/src/run/record.ts`; Run/store and resume tests. |
| Resume observes references without blind resubmission | Run submission fences and resume tests; both CLI process proofs preserve references and transaction counts. |
| Clean viem lifecycle reaches convergence | `scripts/test-packed-anvil.mjs`: public package planning, review, exact execution, observation, verification and zero-action replan. |
| Sender-sensitive viem plans block before signing | Provider contract and viem tests; packed checked-beacon owner mismatch proof. |
| Required onchain enforcement blocks viem | `viem-provider.test.ts` and provider-neutral requirement checks. |
| Viem process recreation retains the same transaction | `scripts/test-cli-anvil.mjs`: new CLI process, same reference, unchanged nonce, fresh convergence. |
| Adapter imports only public released/packed SDK contracts | Boundary gates and `vendor/oaath/provenance.json`; no source checkout or internal imports. |
| One all-chain Grant compiles from the reviewed plan | Adapter tests and `scripts/fixtures/oaath-consumer.mjs`: one approval and two-chain convergence. |
| OAAth review exposes actual signer, route and enforcement | Public `Grant.reviewCalls`, immutable adapter binding and changed-authority rejection tests. |
| OAAth process recovery keeps the same operation | `scripts/fixtures/oaath-process-consumer.mjs`: producer SIGKILL before observation, new packed CLI/SDK process, same Run/reference, unchanged transaction count and fresh verification. |
| Moesi contains no OAAth implementation | Dependency/source boundary gates and 34 hostile/environment cases; OAAth owns testing, signing, submission, observation and persistence. |
| CLI requires explicit provider selection | CLI argument tests and actual packed `apply` invocations. |
| Switching provider requires new review | Core binding/Run provider checks and CLI accepted-review tests. |
| Clean consumers have no cross-repository source imports | Packed library, CLI and OAAth gates; tarball provenance, source scanning and installation outside the workspace. |
| Three public packages remain 0.x | All three manifests and packed coordinates are `0.14.0`, fixed by Changesets; packed CLI/core and adapter peer checks verify installed metadata. |

## Product coverage

The implementation owns bounded JSON/YAML parsing, explicit resource references,
pinned discovery and observation, drift, deterministic calls and dependency
ordering, runtime prerequisites, provider review, durable Runs and independent
semantic verification. Supported deployment paths include canonical CREATE2,
sender-protected and explicitly unguarded CreateX CREATE2, explicitly unguarded
CreateX CREATE3, and the checked beacon/proxy compiler. CREATE3 has address-vector,
init-code-independence and local-chain convergence tests. The issue's named
responsibilities are covered by the current manifest, planning, execution and
verification modules.

The four [runnable examples](../examples/README.md) cover direct viem, OAAth,
one-Grant multichain execution, and repair after actual configuration drift.
Provider finality and deployment convergence remain separate evidence boundaries.

## Final versioned checks

- `pnpm check`: 456 unit tests, 34 boundary/environment cases, reproducible beacon
  artifacts, lint, build and typecheck.
- `pnpm audit:prod`: no known vulnerabilities reported on 2026-09-28.
- `pnpm test:anvil`: 12 local onchain tests, viem CLI process recovery, packed
  lifecycle/beacon proofs, packed OAAth library/CLI/process recovery, and all four
  runnable examples.
- `node scripts/smoke-packed-library.mjs` and
  `node scripts/smoke-packed-cli.mjs`: isolated current-version package metadata,
  contents and behavior, including a direct consumer with no OAAth dependency.

OAAth owns its independently reviewed prerequisite PRs
[#172](https://github.com/leekt/oaath/pull/172),
[#174](https://github.com/leekt/oaath/pull/174),
[#177](https://github.com/leekt/oaath/pull/177),
[#178](https://github.com/leekt/oaath/pull/178),
[#180](https://github.com/leekt/oaath/pull/180), and
[#182](https://github.com/leekt/oaath/pull/182).
The vendored group is packed from merged commit
`ba1e0f84401ee86aba945119663d925fb301c11a`, with SHA-256 sums for every artifact.

Moesi's adapter, CLI, text/references, boundary gates, discovery, semantic checks,
beacon strategy, examples and process proof were independently reviewed in
[PRs #37–55](https://github.com/leekt/moesi/pulls?q=is%3Apr+is%3Amerged).
An independent final functional audit found no additional required behavior gap.
The versioning PR records its own exact-head review and CI result.

## Evidence limits and distribution

The process proof preserves the local Anvil processes while replacing the SDK
and CLI processes. It proves the upstream fixture's durable direct Grant,
Operation and context path, not production SQLite, arbitrary wallet/key custody,
hosted infrastructure or physical-device behavior. The tested crash occurs after
PID handoff; pre-ready fixture startup ownership is a separate nonblocking
[OAAth follow-up](https://github.com/leekt/oaath/issues/183).

The epic explicitly permits exact local tarballs and public released/packed SDK
paths. Source versioning and these packed proofs satisfy that route. npm still
contains the earlier Moesi/CLI `0.13.0` and OAAth `0.1.0` releases as of the registry
check on 2026-09-28; the new versions were unused. Publishing is a separate manual
action and has not occurred. Old artifacts and APIs are rejected; no compatibility
or migration path is claimed.
