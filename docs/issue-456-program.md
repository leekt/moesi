# Issue 456 completion ledger

> Historical record from 2026-09-28. Repository, package, schema, tooling, and
> application-status statements below describe the recorded checkpoints. See the
> [current README](../README.md) and later acceptance records for current behavior.

Objective: achieve [leekt/deployer#456](https://github.com/leekt/deployer/issues/456),
including its provider-neutral execution amendment. Audited 2026-09-28. This is
a separate objective from the completed CLI/SDK usability review.

## Current authoritative state

- Public `leekt/moesi` exists; remote main is now
  `5bb192b85f30a521e90160774cf82927fc98ce63` (OS-process recovery PR #55).
- Core/CLI streams in Moesi PRs #1–16 and corrective PRs #23–35 are merged.
- The original working directory has uncommitted usability/probe fixes; they
  remain intact and are not silently folded into the adapter work.
- Moesi adapter worktree: `/Volumes/Workspace/workspace/moesi-oaath-adapter`,
  branch `feat/issue456-oaath-adapter`, initially at the remote main above.
- Published `@oaath/sdk@0.1.0` was inspected from its registry tarball, not
  inferred from current source. It lacks public pre-send review, operation-ID
  recovery, and exact finalized-call evidence needed by the adapter.
- OAAth main `baef6363dffa2fc5c627a141007ed241ce310242` adds operation IDs and
  read-only `getOperation`, but still lacks pre-send review and finalized-call
  projections. OAAth work proceeds in its own repository/worktree at
  `/Volumes/Workspace/workspace/oaath-moesi-execution`; the existing OAAth
  working directory is untouched. Moesi may consume only released packages or
  exact packed artifacts from that work.

## Requirement-to-proof ledger

| Requirement | Current evidence / required work |
| --- | --- |
| New public repository, provider-neutral core, no copied OAAth | Repository and public package boundaries present; PR #43 adds automated dependency/source boundary gates and 34 hostile/environment fixtures. |
| Immutable reviewed plan and explicit provider binding | Existing codecs, contract tests, and merged direct-viem flow. Preserve these invariants in adapter integration. |
| Pinned observation, drift, deployment, configuration, runtime dependencies | Existing tests and local-Anvil/packed proofs cover shipped strategies. YAML/stdin and explicit references merged in PRs #41/#45. Discovery and semantic manifest/drift/verification checks merged in PRs #47/#49. Checked beacon deployment/upgrade compilation merged in PR #51. |
| Durable Run, monotonic partial progress, observe-only recovery | Existing core/CLI stores and process-recreated viem proofs. Add recreated OAAth operation proof with no new send. |
| Direct viem sender/enforcement rules and clean consumer | Existing local and packed tests; rerun integration gates on the final candidate. |
| Optional OAAth adapter over public SDK | PR #37 merged: public SDK review/submit/observe, all-chain Grant compilation, exact checksummed upstream tarballs, packed two-chain convergence. |
| Actual OAAth signer/route/enforcement review | Public SDK Grant.reviewCalls projection merged upstream; Moesi binds its actual facts to immutable review and refuses changed authority before send. |
| OAAth references and finalized calls survive recreation | Packed proof recreates SDK/DB/Moesi handles over retained backing memory and recovers exact finalized calls without another send. OS-process SDK durability still needs a separate proof. Registry SDK release also remains. |
| CLI explicit viem/OAAth selection and new review on provider change | PR #39 merged: lazy optional adapter, explicit authorization, caller-owned SDK composition and reference-only recovery. |
| Three public 0.x packages, fixed release group, package isolation | Three packages and fixed 0.x group with packed isolation proof present. Final versions/releases must account for registry moesi 0.13.0 already existing and registry SDK 0.1.0 lacking new APIs. |
| Minimal viem/OAAth, multichain OAAth, drift-repair examples | PR #53 merged all four runnable examples with isolated packed/public-package Anvil proofs, including OAAth absence on direct consumers. |
| Bounded child issues and independently reviewed PRs | Existing merged streams are recorded upstream. New work will use focused children and review the actual candidate heads before merging. |

Completion is unproven until every requirement and named gate in the source
issue has final-state evidence. Neither a stub adapter nor a passing mocked
provider suite closes the OAAth path.

## SDK prerequisite progress

- [OAAth #172](https://github.com/leekt/oaath/pull/172) merged as
  `b090f68` after independent acceptance of `1bfead4` and passing CI.
  `Grant.reviewCalls` exposes the SDK-owned sender, signer, route, policy and
  enforcement facts without signing, submission, quotes or durable writes.
- [OAAth #173](https://github.com/leekt/oaath/issues/173) owns the next focused
  child: exact finalized `Operation.execution()` evidence decoded from the
  containing EntryPoint transaction, bound to the retained operation hash.
  Focused tests, local Anvil with recreated SDK/database handles and zero
  resubmission, and the packed public consumer pass locally. Independent review
  and merge completed in [OAAth #174](https://github.com/leekt/oaath/pull/174),
  merged as `5fa5e2f`. This is still an upstream prerequisite, not proof that
  the Moesi adapter exists.
- [OAAth #175](https://github.com/leekt/oaath/issues/175) adds a packed Node-only
  local Anvil consumer fixture. OAAth owns its Kernel deployment, authorization,
  submission, observation, and reopenable storage. A clean two-chain consumer
  proves one approval and exact recovery with zero resubmission. This lets Moesi
  prove the adapter without copying OAAth implementation into integration tests.
  Independent review accepted exact head `2d7ce02`; PR #177 merged as
  `25335ee` with passing CI.

- [OAAth #178](https://github.com/leekt/oaath/pull/178) removes an invalid ABI-word
  alignment restriction on selector-prefixed calls, preserving exact word checks
  for constrained arguments. Independent review accepted `caa1c08`; CI passed
  and the fix merged as `f3ea421`. Packed proof deploys raw CREATE2 calldata and
  verifies exact recovered calls.
- [Moesi #36](https://github.com/leekt/moesi/issues/36) owns the adapter child.
  Implementation is in the isolated adapter worktree. Exact four-package OAAth
  artifacts from `f3ea421` are pinned with SHA-256 provenance. Initial contract
  tests and a clean two-chain packed consumer pass: one Grant, exact deployment
  calls, recreated SDK/store handles, zero resubmission and Moesi convergence.
  Independent review accepted exact head `b63ebca`; CI and all focused/packed
  checks passed. [PR #37](https://github.com/leekt/moesi/pull/37) merged as
  `a22056f`. This fixture
  keeps the backing processes alive; it does not claim OS-process durability.

- [Moesi #38](https://github.com/leekt/moesi/issues/38) owns optional CLI OAAth
  selection and explicit authorization. Worktree `/Volumes/Workspace/workspace/moesi-oaath-cli`
  branches from merged `a22056f`. Independent review accepted exact head
  `cf80f84`; CI passed. [PR #39](https://github.com/leekt/moesi/pull/39) merged
  as `bc960d2`. Packed CLI proof covers one consent, review without sending,
  safe stop with a retained reference, handle recreation and convergence with
  one send; it does not claim OS-process SDK durability.

- [Moesi #40](https://github.com/leekt/moesi/issues/40) owns public JSON/YAML
  manifest document parsing and CLI stdin. Worktree
  `/Volumes/Workspace/workspace/moesi-manifest-text`, branch
  `feat/issue456-manifest-text`, is based on merged `bc960d2`. Independent review
  found and the revision fixed raw forbidden YAML characters in comments.
  Accepted exact head `0aa4533`; 401 tests, packed proofs and CI pass. PR #41
  merged as `ad23cdc`.

- [Moesi #42](https://github.com/leekt/moesi/issues/42) owns automated package
  boundary checks and test environment isolation. Worktree
  `/Volumes/Workspace/workspace/moesi-boundary-gates`, branch
  `feat/issue456-boundary-gates`. Independent review found and revisions fixed
  dependency shorthand sources, CommonJS module.require and imports into ignored
  build output. Exact head `b4dd6f9` accepted; CI passed. PR #43 merged as
  `abec601`. 34 boundary/env tests, 401 unit tests, lint/build/typecheck, 11 local
  onchain tests, CLI process recovery and all packed consumers pass. No workflow edits.

- [Moesi #44](https://github.com/leekt/moesi/issues/44) owns explicit ABI
  resource-address-word references in configuration and attestation byte fields.
  Worktree `/Volumes/Workspace/workspace/moesi-manifest-references`, branch
  `feat/issue456-manifest-references`, based on merged `abec601`.
  Source and resolved manifest types are separated; plans keep literal bytes.
  Independent review found and revisions fixed revoked-proxy error leakage and
  stale Run error-code normalization. Exact head `6e37c4d` accepted; CI passed.
  PR #45 merged as `1c640e6`. 34 boundary and 417 unit tests,
  lint/build/typecheck, release check, 11 Anvil tests (including resolved calldata
  execution), CLI process recovery and packed library/CLI/OAAth proofs pass.
  Manifest, reviewed-plan and deployment-run schemas are v3; CLI plan wrapper v2.

- [Moesi #46](https://github.com/leekt/moesi/issues/46) owns pinned read-only
  resource discovery. Worktree `/Volumes/Workspace/workspace/moesi-discovery`,
  branch `feat/issue456-discovery`. New discover API captures selected addresses,
  exact callers and bounded probes; returns code/hash, ERC-1967 slot/beacon,
  owner and explicit role facts only after final ancestry validation.
  25 focused tests, all 442 unit tests, 34 boundary tests, lint/build/types,
  local Anvil discovery and packed library proof pass. This does not complete
  desired semantic checks, drift/verification integration, proxy strategy or CLI discovery.
  Independent review accepted exact head `2521c30`; CI passed. PR #47 merged as
  `35147c9`. Packed OAAth public type/consumer proof also passes.

- [Moesi #48](https://github.com/leekt/moesi/issues/48) owns explicit semantic
  manifest checks compiled into reviewed assertions and used by drift/fresh
  verification. Work begins in `/Volumes/Workspace/workspace/moesi-semantic-checks`,
  branch `feat/issue456-semantic-checks`, based on merged `35147c9`.
  Independent review accepted exact head `3771ef4`; CI passed. PR #49 merged as `8e525b1`. It compiles explicit owner,
  role/member/admin and direct/beacon ERC-1967 expectations to exact read-only
  assertions with semantic kinds and call targets. Planning, fresh verification
  and Run convergence share strict ABI decoding; only independent configuration
  rules authorize writes. 452 unit and 34 boundary tests, lint/build/types,
  release check, 12 Anvil tests, a focused zero-send Run convergence regression,
  CLI process recovery, and packed library/CLI/OAAth proofs pass.
  Manifest/plan/run v4; CLI plan/execution-review/run-result v3; core
  verification-result/run-result v2. No compatibility readers.

- [Moesi #50](https://github.com/leekt/moesi/issues/50) owns the checked beacon
  deployment/upgrade compiler. Worktree `/Volumes/Workspace/workspace/moesi-beacon-strategy`,
  branch `feat/issue456-beacon-strategy`. Independent review accepted exact head `3750584`; CI passed. PR #51 merged
  as `f0f95e7`. It compiles pinned OpenZeppelin-based checked contracts
  to ordinary current manifests, with EOA owner requirements, fixed constructor
  identity, runtime-hash guards and typed semantic assertions. 456 unit/34 boundary
  tests, exact artifact reproduction, lint/build/types, release check, 12 Anvil
  tests, CLI process recovery and all packed consumers pass. Packed real-chain
  proof verifies initialization, one-call upgrade, preserved storage, wrong-owner
  and changed-code/beacon guard reverts, drift and fresh convergence. No storage
  layout/initializer analysis or arbitrary existing proxy support.

- [Moesi #52](https://github.com/leekt/moesi/issues/52) owns the four executable
  public-package examples. Worktree `/Volumes/Workspace/workspace/moesi-examples`,
  branch `feat/issue456-examples`. Independent review accepted exact head
  `de495a1`; CI passed. PR #53 merged as `2ccf3b8`.
  `pnpm examples:local [name]` installs packed isolated consumers and runs local
  chains only; direct consumers have no OAAth dependency, multichain OAAth uses
  one approval and two sends, and drift repair follows a real external change
  with one reviewed configuration write. All four examples and the combined
  packed onchain/OAAth gate pass; 456 unit/34 boundary tests, lint/build/types,
  artifact reproduction and release check pass. Memory-store evidence limits
  remain explicit.

- [OAAth #179](https://github.com/leekt/oaath/issues/179) owns the OS-process
  recovery prerequisite. Worktree `/Volumes/Workspace/workspace/oaath-process-recovery`,
  branch `test/local-process-recovery`, based on upstream `f3ea421`.
  Independent review accepted exact head `fd5f44e`; CI passed. PR #180 merged
  as `399ae1a`. Fifteen focused tests, typecheck/lint, public-surface/release
  checks, existing packed two-chain proof and new packed producer/SIGKILL/
  failed-observation/fresh-recovery proof pass. The operation is submitted
  before process loss; unreadable evidence remains pending and the same exact
  calls recover in a new process with no new transaction. Durable direct
  Grant/Operation/context SQLite v2 only; no wallet/key/native durability claim.

- [Moesi #54](https://github.com/leekt/moesi/issues/54) owns the downstream packed
  CLI OS-process recovery proof. Worktree
  `/Volumes/Workspace/workspace/moesi-process-recovery`, branch
  `test/issue456-process-recovery`, based on `2ccf3b8`. It consumes only exact
  public artifacts from the merged OAAth commit and adds a real producer-kill /
  fresh CLI resume path over the file Run store. Independent review accepted
  `d4e7102`; CI passed and PR #55 merged as `5bb192b`. All456 unit/34boundary
  cases, lint/build/types, artifact reproduction and release check pass; packed
  public consumers prove CLI producer SIGKILL before observation, fresh-process
  same Run/reference recovery, unchanged transaction count and fresh convergence.
  A failure-before-fixture-startup PID-handoff limitation is a separate upstream
  follow-up; post-handoff intentional crash cleanup passed.

- OAAth #181 / PR #182 prepares its fixed source package group as0.2.0 using
  existing Changesets. Worktree `/Volumes/Workspace/workspace/oaath-release-020`,
  branch `release/0.2.0`, accepted head `2d4130b`. CI passed; PR #182 merged
  as `ba1e0f8`. Versioned packed local and OS-process consumers,
  typecheck/lint/format/public-surface pass.
  No npm or native publication is authorized or attempted by that child.
- Moesi #56 / version work prepares `0.14.0` (registry `0.13.0` already exists),
  peer alignment and exact reviewed OAAth `0.2.0` artifacts, plus final epic audit.
  Worktree `/Volumes/Workspace/workspace/moesi-release-014`, branch
  `release/0.14.0`, candidate `d2a22f7`. Final versioned gates pass: 456 unit
  tests, 34 boundary/environment cases, reproducible artifacts, lint/build/types,
  production audit, 12 local onchain tests, both CLI process recovery paths,
  all packed library/CLI/provider/beacon proofs and all four examples.
  Independent functional audit found no missing requirement: CREATE3 already
  exists as `createx-create3-unguarded-v1`; the source issue explicitly allows
  exact local tarballs without requiring npm publication. Independent final
  version review accepted exact head `d2a22f7`; CI passed. PR #57 merged as
  `f45aad8e5b1c02e2e31af4c389e77ac3bdd43903`, with the same reviewed tree.
  User explicitly excluded iOS; no manual native edits/tests.
  Original dirty Moesi/OAAth worktrees remain untouched except this ledger.

## Completion

The issue #456 implementation and release preparation are complete through
merged source and exact reviewed package artifacts. The final acceptance record
is `moesi-release-014/docs/issue-456-acceptance.md`. Moesi is version `0.14.0`;
its exact OAAth package group is version `0.2.0` from merged `ba1e0f8`.
All required local checks, independent reviews and CI passed. The seven-artifact
bundle is `moesi-release-014/.artifacts/moesi-0.14.0-reviewed-artifacts.tar.gz`,
with source provenance and SHA256 checksums. A clean bundle install and CLI help
smoke check passed. npm publication was not performed; iOS is excluded.
The nonblocking pre-handoff fixture cleanup follow-up is OAAth issue #183.
