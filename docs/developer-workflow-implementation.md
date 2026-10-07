# Developer workflow implementation

This work implements Moesi issues #58–#62 and checks the developer paths they
affect. Implementation and required validation run together; there is no
separate review phase or independent-review gate.

Orchestra's [compiler artifact storage acceptance](dx-review/orchestra-artifact-storage-acceptance.md)
records the completed storage prerequisite. Its subsequent
[receipt recovery checkpoint](dx-review/orchestra-receipt-recovery-acceptance.md)
uses the packed current OAAth reference reader and proves recovery of a local
Kernel v3.3 operation after reopening. The current manifest/export and execution
cutover, full application checks and remaining recovery paths are unfinished.

Orchestra's cutover exposed a pure registration-preview requirement before a
runtime expectation exists. `compileDeploymentRecipe` now captures the closed
deployment/sender shape through the manifest's parser and uses the same address
and calldata owners as reviewed planning. No placeholder runtime hash or review
authority is invented. Protected CREATE2/CREATE3 keep the exact owner or logical
smart-account sender. All five strategies match their reviewed plan calls; the
Across vector remains exact. The packed consumer proves public types, required
protected senders and immutable output. Local Anvil evaluates linked constructors
using these compiled calls, then the exported plan deploys and converges.

Validation: `pnpm check` passes 680 package tests (482 core, 49 adapter, 149 CLI),
plus the boundary gates, lint, typechecks and builds. The packed library consumer
and all 21 core Anvil convergence/probe tests pass. Orchestra's full cutover is
still in progress; its focused exporter/observation proofs do not establish full
application readiness.

## Implemented foundation: durable fleet observations

`moesi/fleet` now owns versioned single-chain observation records, immutable
validation, revision-based store transitions and `observeFleetChain`. A scan
reserves its revision before compilation or planning; older completion cannot overwrite a
newer attempt, including after clock rollback or a manifest change. Planning
reuses compiler pins and shares source/peer pins. Pending and failed attempts
retain the prior complete snapshot. Partial plans, unknown peers and safe causes
remain explicit under failure evidence. Returned records are reloaded from
storage before publication. Observation v2 binds the desired definition separately
from the compiled manifest; `prepare` runs inside the reserved attempt. Failed
compilation persists its own status and keeps prior complete evidence.
Regression tests cover a slow old compiler, changed definitions, cancellation
and late compiler completion.

`moesi/node` supplies a SQLite implementation with atomic transactions, bounded
lock waits and one row per chain. Browser imports stay independent of this
entry point. A packed public consumer races two processes on the same revision,
kills a worker after reservation, then reopens and recovers without losing the
committed snapshot. Bun 1.3.14's `node:sqlite` import did not work in this environment;
the SRA service now supplies its own native `bun:sqlite` host, described below.

[SRA offline persistence acceptance](dx-review/sra-observation-acceptance.md)
passed for the saved 22-chain fleet: 166 cells, 2,410 configuration rows and 67
exact decimals reads, with no cache misses or external RPC. Reopening preserved
every plan/read; injected incomplete reads retained the prior complete snapshot.
This is cached evidence, not a fresh network scan or proof of application UI
readiness.

Validation: `pnpm check` passed (36 boundary tests and 667 package tests),
including 17 focused observation regressions. The packed public consumer passed.

## Implemented application path: SRA observation service

SRA's isolated adoption branch now uses the exact packed Moesi artifact from
`58521cd` for its observation service. Its typed fleet compiles selected source
chains while preserving the complete peer catalog. This selection option is
validated before author callbacks and covered by unit and packed-consumer tests.
The service imports only public current APIs; the old resolver and JSON-cache
readers/writers are removed from the backend.

SRA's native Bun SQLite store validates the public record and transition codecs,
commits revisions atomically, and retains complete evidence across failed scans
and process loss. The actual host tests race separate Bun processes on one
revision and kill a worker after reservation before reopening and recovering.
The HTTP service queues/coalesces refreshes, rejects stale publication, cancels
uncooperative reads, isolates corrupt chains, and boots without RPC. It validates
saved compiler reads against current authoring inputs before projecting status.
Exact host/origin checks, authentication and bounded request bodies remain
explicit. Missing prerequisites and peer runtime mismatch cannot appear healthy.

[Application acceptance](dx-review/sra-service-acceptance.md) exercises the real
compiler, scanner, store and HTTP handlers against the saved 22-chain fleet:
166 cells and 2,410 rows converge, with no cache misses or external RPC. The
database reopens with an identical product projection, and a failed compilation
retains the previous complete snapshot. Twenty-one Across immutable getter
results were separately evaluated in local Anvil from the saved exact runtime;
they are distinguished from the original pinned RPC reads.

The application checkpoint is SRA `68c490362e48cb21d2573cdd44ea86c4aa09c31c`.
Its 48 tests, frontend/server typechecks, focused lint and production build pass.
This proves the backend cutover. Browser execution still uses 0.9; its OAAth
adoption, browser lifecycle/concurrency and Orchestra's application paths remain
unfinished. No live signing or submission occurred.


## Implemented: compiler artifact inputs

`prepareSolidityArtifact` accepts full Foundry, solc contract-output and Hardhat 3
artifacts. It captures inputs, links exact creation/runtime slots, validates
constructor arguments, and produces immutable literal manifest bytes plus
versioned provenance. Static runtime hashes come from compiler output;
immutables and library self addresses require explicitly supplied runtime bound
to the exact init-code hash. Template bytes outside those ranges cannot change,
and repeated immutable occurrences must agree. The helper performs no RPC and
does not claim to authenticate a compiler or the evaluator's deployment context.

The local Anvil proof evaluates a linked library and a constructor that embeds
its caller and a newly created child's address at the actual CREATE2 targets.
JSON and YAML exports produce the same plan; applying it converges and the next
plan has no changes. The public API also passes a packed, typechecked consumer.

[Actual SRA acceptance](dx-review/sra-artifact-acceptance.md) covers all seven
recipes, 144 managed cells and 39 constructor contexts using complete compiler
artifacts, the original 0.9 constructor inputs, saved pinned dependencies and
fresh local execution. Creation bytes and runtime hashes match with zero external
RPC requests. Application catalog persistence and Orchestra's standalone export
cutover remain required; the generic compiler proof does not replace them.

Validation: `pnpm check` passed (36 boundary tests and 647 package tests); the
artifact suite then passed 15 tests after adding Foundry-empty-map and unreadable
runtime regressions. The focused Anvil test and `pnpm smoke:packed:library` pass.

## Implemented: #58, exact smart-account CreateX senders

- Sender-protected CREATE2 and CREATE3 accept a pinned smart-account ID and
  address. Prediction, calldata, configuration read callers, provider review,
  and finalized execution evidence bind the same address.
- Offline prediction reproduces the SRA Across adapter
  `0xafdea3e6716239482c2378a3bf6d24fbdd99b077` and resolver
  `0xd91b39e398490abaadc79011524d28e6854ef48d` from their existing sender and salts.
- Changed persisted shapes have new outer versions; old artifacts fail at the
  version boundary. The changeset records the breaking authoring changes.
- The packed public OAAth consumer deploys both strategies on two local Anvil
  chains, rejects a mismatched sender before submission, verifies runtime code,
  and replans with zero actions. This proves the existing SDK's smart-account
  execution path; Kernel v3.3 integration remains part of #62.
- `pnpm typecheck` builds all workspace dependencies first, including the
  adapter needed by the CLI in a fresh checkout.

Validation: `pnpm check` (34 boundary tests and 464 package tests),
`pnpm smoke:packed`, `pnpm smoke:packed:oaath`, and `pnpm test:anvil` passed.
RPC validation used owned local fixtures only.

## Remaining requested work

- Developer paths: exercise packed library and CLI usage, authorization,
  recovery, cancellation, fleet status, migration, and app composition as the
  corresponding changes land. Carry forward the existing diagnostics/probe
  fixes from the original working tree without overwriting that work.
- Application adoption: artifact/immutable authoring and standalone exports,
  durable fleet observations, actual browser/database concurrency and recovery,
  and the SRA/Orchestra cutover gates need their own implementation and evidence.
  Local packed fixtures do not establish full application readiness.

## Implemented: #60, a shared viem read pool

- `createViemObserver` accepts per-chain URL pools and pin policies. Default
  limits are three attempts, ten-second complete HTTP exchanges, and eight
  concurrent reads. Failover preserves exact block hashes and callers.
- Reads validate chain identity and JSON-RPC response IDs. HTTP 429/5xx,
  non-JSON responses, missing archive state, replica failures, timeouts, and
  malformed results are classified separately from terminal reverts and other
  RPC failures.
- Each chain pins immediately before its reads. Optional lagged pins remain
  exact. Same-stage checks run concurrently; `batch: true` groups JSON-RPC
  requests while preserving caller semantics.
- Plan and verify cancellation reaches both queued and active HTTP reads.
  Tests cover cancellation races and servers that send headers then stall.
- Safe causes retain endpoint index, category, HTTP status, and RPC code in
  plans, verification, snapshot errors, and CLI output. Raw URLs, provider
  messages, bodies, and abort reasons are excluded.
- CLI observation now uses the shared core observer. Changed persisted shapes
  have new outer versions and release notes.

Validation: `pnpm check` (34 boundary tests and 481 package tests),
`pnpm smoke:packed`, and `pnpm test:anvil` passed. The last command includes the
packed OAAth consumer using the new observer for real two-chain smart-account
deployment, durable recovery, CLI execution, and all four local examples.

## Implemented foundation for #59: drift-only batches and peer readiness

- Literal configuration rows declare contiguous batch metadata. Planning merges
  only drifted, ready rows in declaration order, bounded by `maxRows`, and retains
  every exact row postcondition. Persisted-plan validation recompiles the same
  calls and rejects altered row coverage or calldata.
- Literal peer prerequisites produce immutable, deduplicated block-pinned
  evidence. Missing peers leave rows pending; unreadable or changed runtimes
  block them. Apply and resume recheck peer runtime and lineage before crossing
  the durable submission fence. Fresh convergence also verifies peer lineage.
- The CLI accepts exact read-only `--peer-chain` bindings without promoting
  peer chains to deployment targets or loading their signers. Plan, inspection,
  and verification output expose readiness and peer evidence.
- Updated persisted shapes have new explicit versions and release notes.

Validation: `pnpm check` passed (34 boundary tests and 502 package tests),
`pnpm smoke:packed` passed with an isolated consumer covering a 143-row matrix,
and `pnpm test:anvil` passed, including packed OAAth library/CLI recovery and all
four local examples. The new Anvil route contract records three writes for 143
initial rows; after two rows change, Moesi submits one call with exactly those
two rows, verifies convergence, and replans without actions.

The following sections record the completed authoring, parity comparison and
real-fleet migration acceptance for #59.


## Implemented authoring for #59: `moesi/fleet`

- Public `defineFleet` compiles per-chain resource and configuration callbacks
  into frozen, JSON-safe plan inputs. Equal manifests group deterministically
  with at most 32 chains each; excluded resources and empty chains are omitted.
- ABI-typed rules preserve read arguments, expected return types, write arguments
  and per-row postconditions. Constructor references resolve lazily with cycle
  detection. Public account descriptors remain caller-owned; no signing or
  account-abstraction implementation moved into Moesi.
- Cross-chain live reads pin once per chain and deduplicate exact requests.
  Compilation records the literal return bytes and pins, checks canonical ABI
  decoding, retains bounded causes, and propagates cancellation without raw
  provider details or abort reasons.
- Canonical tuple-array batch parameters support SRA's asset-fee struct rows as
  well as its route matrix. The local Anvil fixture deploys two fee rows, changes
  one asset, and proves the repair call contains only that asset.
- `docs/migration-0.9.md` maps removed authoring features to current API calls and
  provides a typed route-matrix example. Its code is typechecked against the
  packed package, alongside positive and negative public ABI-surface fixtures.

Validation: `pnpm check` passed (34 boundary tests, 510 package tests),
`pnpm smoke:packed` passed, and `pnpm --filter moesi test:anvil` passed (14 tests).
The synthetic fleet test expands 22 chain variants with 143 rows apiece. This
proves compilation at the requested scale. Live SRA parity requires comparison
with the actual application inputs.

## Implemented comparison for #59: live fleet parity

- `parseFleetBaseline` validates one explicit current version of independently
  resolved application declarations. It rejects unknown fields, accessors,
  duplicate resource/read identities and unsupported versions before RPC.
- `checkFleetParity` compares baseline and candidate resource addresses, code
  expectations, configuration, assertions, storage and peer prerequisites,
  and observes both at shared exact pins. Reports retain safe unreadable causes
  and partial chain evidence. Read labels can change without hiding differences
  in caller, target, calldata, slot, expectation or readiness requirements.
- `moesi check-parity` exposes human and JSON reports without loading a signer,
  provider or Run store. Its exit codes distinguish match, differences,
  unreadable evidence and invalid input. The migration guide describes the
  independent export and explicitly separates parity from convergence.
- An actual local-chain fee mutation remains a parity match while both sides
  report drift. The resulting plan repairs only the changed asset.

Validation: `pnpm check` passed (34 boundary tests, 529 package tests),
`pnpm smoke:packed` passed with public types, immutable library evidence and CLI
match/difference/unreadable paths, and `pnpm --filter moesi test:anvil` passed
(14 tests). These automated checks used local fixtures only.

## Actual SRA acceptance for #59

The [manual application comparison](dx-review/sra-live-parity.md) uses the exact
22-chain PR #18 source with its original 0.9.0 public address predictor and data,
plus an isolated packed current library. All 22 comparisons match, all 166
resource cells converge, and all 2,410 configuration rows remain equivalent.
The live CLI Monad comparison also exits 0 with a converged plan. Evidence
retains exact pins, code hashes, plan IDs, constructor-read provenance and
package/input hashes. Live access was read-only; constructor validation used
local Anvil.

This exercise also fixed throttling diagnostics and bounded shared endpoint
cooldowns in the observer. `pnpm check` passed (34 boundary tests, 532 package
tests); the packed public observer configuration and fleet consumer passed.
The remaining OAAth flow is tracked above; owner selection is implemented below.

## Implemented foundation for #61: atomic operation packing and recovery

- `ExecutionPacking` selects per-chain or per-step submission. Atomic providers
  expose `submitBatch`; their default is one operation per chain. The direct
  viem provider retains per-step transactions. Unsupported explicit packing
  fails before submission, and recovery retains the original choice.
- Execution reviews bind packing and require exact sender, signer and a bounded
  structured signer reason. Provider review and prepare receive the same choice.
  The CLI shows operation/call counts and exact step membership; changing
  `--packing` invalidates the acceptance digest.
- Durable Runs own operations with ordered step IDs, one submission fence,
  one opaque reference and one evidence boundary. Ambiguous submissions remain
  fenced. Recovery of submitted work only observes the retained reference.
- Finalized calls must match the entire ordered batch and sender. Reordered,
  duplicated, missing or modified calls fail; finality never proves convergence.
  Configuration skips apply only when the entire operation is satisfied.
- Cold deployment/configuration batches recheck existing capabilities and
  prerequisites before submission. Runtime dependencies created earlier within
  the same atomic batch are checked during fresh post-operation convergence.
  Per-step execution retains intermediate runtime checks.
- OAAth reviews and sends the full chain batch, and permission limits count
  operations. The owner path below extends the initial session implementation.
- Execution review v3, durable Run v9 and result v6 are current after the owner
  addition. CLI review/result v8, status v3 and permission v2 expose membership
  and the permitted/actual submission route.

Validation: `pnpm check` passed (34 boundary tests and 547 package tests).
Packed library and CLI consumers passed. Local Anvil coverage passed (14 tests),
as did the CLI finality/recovery fixture, packed direct-provider/checked-beacon
fixtures and all four runnable examples. The real packed OAAth SDK submitted
cold deploy/configure batches and protected CREATE2/CREATE3 pairs in one
operation per chain on two local chains. A fresh CLI OS process recovered a
two-call batch after the producer was killed, preserving its reference and
transaction count. All automated RPC access used owned local fixtures.

## Implemented: #61 owner selection and #62 owner execution

- The adapter accepts an existing account, a browser or local viem owner wallet,
  and explicit signer/sender choices. Auto selects an available owner for one
  estimated operation per chain. Plans requiring onchain policy enforcement use
  sessions. Failed estimation blocks without signing or creating permissions.
- The public SDK verifies the existing Kernel v3.3 account and root owner.
  Moesi submits the full reviewed call sequence once. Review includes the smart
  account, signer reason, actual enforcement, and conditional handleOps fallback.
- Conclusive pre-acceptance bundler rejection can send the identical signed
  operation through the connected/local EOA. Uncertain failures do not permit
  fallback. Finalized evidence carries the SDK's actual route separately from
  Moesi's deployment convergence evidence.
- The CLI module returns provider options. Owner-only applications skip
  `authorize`; review still estimates before requesting a signature. The same
  account and SDK journal recover submitted owner work without a wallet.
- Exact OAAth artifacts record local owner estimation/wallet fixes and a public
  Kernel v3.3 consumer fixture. No OAAth source imports or AA implementation
  entered Moesi. The boundary gate permits only the SDK review metadata fields
  at the adapter capture boundary.

Validation: the packed consumer performs a cold deploy/configure batch with
browser and local owners through both bundler acceptance and conclusive rejection.
Each case uses one signature and one bundler attempt; rejected cases use one
fallback send. Fresh SDK and Run stores recover the retained reference without
a wallet, verify exact calls and actual route, prove convergence, and replan with
zero actions. The packed CLI also stops after owner submission and resumes with
the wallet removed. The fixture supplies fixed gas estimates; real EntryPoint
validation/execution and canonical local receipts prove those complete batches
fit. No live chain or hosted bundler was used.

`pnpm check` passed with 35 boundary tests and 557 package tests; the added
configured-account/session regression raises package coverage to 558 tests.
The full issuer-free session workflow and its validation-to-owner fallback are
still required before the overall goal is complete.

## Implemented: preserved probe and CLI developer-path fixes

The original dirty worktree remains intact. Its probe and Nick's-method fixes
are incorporated into this branch: bounded immutable inputs and results,
isolated opcode simulation, no helper-address false positives, exact precompile
responses, explicit inconclusive features, and canonical keyless transaction
encoding. Fifty-one focused tests, nine Anvil probe tests, the full repository
check, and the packed utility consumer passed.

The CLI now saves exact plans with `--out` without replacing files, gives every
command offline help, and supplies scrubbed errors with safe field locations.
Help and recovery guidance cover current OAAth/viem options, atomic operations,
read-only peer bindings, parity versus convergence, and wallet-free observation.
Human Run output presents actual execution and fresh resource evidence, while
interactive stop messages explain the current safe boundary. JSON artifacts and
review acceptance remain unchanged. The checked-in minimal manifest exercises
the real onboarding path. Current `pnpm check` passes 35 boundary tests and
618 package tests (442 core, 35 adapter, 141 CLI).

Runtime cleanup is now secondary to authorization and execution: failed close
emits a scrubbed stderr warning without replacing the original error, result,
or exit code. Regression coverage includes granted/rejected permission, blocked
and accepted reviews, retained submission and reference-only recovery, and both
safe-stop signal codes. This does not create retry authority or delete SDK state.

## Implemented: #62 existing v3.3 session execution and reuse

The exact SDK artifacts now include upstream's existing Kernel v3.3 Grant
runtime, combined with the retained local-wallet and owner-estimation changes.
OAAth's public fixture deploys the real v3.3 account and scoped permission
modules. Its versioned recovery descriptor binds the existing account address;
the credential-free client recovers the original Grant and operation IDs from
SQLite. Two-chain enable, installed-session reuse, and out-of-scope rejection
pass against local Anvil. This fixture uses an in-process test relay and fixed
gas limits; it does not prove issuer-free production composition or bundler
estimation.

The isolated packed Moesi consumer now runs against both v4 and v3.3 sessions.
One approval covers the two chain batches. New SDK and Run instances recover
both references, retain exact finalized calls and sender, and verify convergence.
A new desired configuration creates a new plan and execution review while
reusing the covering Grant, writes silently, converges, and replans with no
actions. Moesi still owns no account-abstraction implementation; only public SDK
metadata fields are permitted in the consumer boundary check.

Validation: `pnpm check` passed (36 boundary tests; 626 package tests: 442 core,
35 adapter, 149 CLI). The full packed OAAth script passed, including existing
owner browser/local wallets, conclusive bundler rejection, protected CreateX,
CLI stop/resume, and process-loss recovery. In OAAth, the focused SDK local-chain
tests and the public fixture tests passed (five tests each), with SDK/testing
typechecks and package builds. No live transactions were submitted.

The session-validation fallback is implemented below. The remaining application
developer paths still require their own implementation and evidence.

## Implemented: #62 issuer-free local sessions

The pinned public SDK now provides `createOAAth({ mode: "local", account, owner,
chains })` for an existing ECDSA-root Kernel v3.3 account. It persists an encrypted
session before wallet consent, validates the root owner, and obtains one exact
Kernel enable approval through the browser or local wallet. The same client
exposes owner execution. Reopening restores the session and exact operation
journal without an issuer service or phone. Moesi continues to own only plan,
provider-review and convergence evidence.

The packed Moesi consumer runs this composition with both wallet fixtures. It
requests permission for a cold two-call deployment/configuration batch, stops
before Moesi observes completion, recreates the SDK and Run store, recovers the
same operation and verifies convergence. A separately reviewed configuration
change reuses the Grant with no additional owner prompt and replans to a no-op.
Final disconnect revokes the permission with one owner operation before deleting
local custody. No extra deployment submission occurs during recovery.

This path exposed and fixed two OAAth-owned bugs: unused-approval revocation
committed against a stale Grant revision, and disconnect attempted sign-out on
already closed short-lived connections. SDK regressions cover both, alongside
rejected/wrong-owner consent, pending consent during close, persistence failures
before consent, and independently failing/retryable store cleanup.

Validation: Moesi `pnpm check` passed (36 boundary tests and 626 package tests),
and its full packed OAAth script passed. The focused OAAth lifecycle suite passed
56 tests; v3.3 runtime/chain-port checks passed eight tests; local wallet/session
fixture checks passed ten. SDK/testing typechecks, lint checks and builds passed.
Artifacts are pinned to OAAth `79329e9`, including upstream revocation `5091579`.
Tests use local Anvil, fixed gas estimates, EIP-1193 wallet fixtures and simulated
IndexedDB. Actual browser-extension interaction, concurrent browser startup and
the SRA/Orchestra application gates still require their own evidence.

Upstream local Grant authorization (`87af134`) is now integrated at SDK `0dc220d`.
The SDK uses its direct local authorization boundary; the earlier in-process
issuer transport and duplicate store factory are removed. The canonical SDK
input is `account: address`; Moesi's provider still uses its own explicit
`account: { address }` descriptor. The combined owner client,
local-wallet signing and lifecycle fixes remain, and upstream's `onApproval`
callback exposes the exact decoded policy before wallet consent.

The updated SDK passes 69 focused client tests, seven local-mode Anvil tests,
three chain-port Anvil tests and the packed Chromium local-wallet script. That
browser proof performs a real IndexedDB page reload and recovers the exact
operation without resubmission. The wallet and estimation remain fixtures;
browser-extension interaction and concurrent startup are not proved by it.
Moesi's full repository check and packed OAAth consumer also pass on these exact
artifacts.

## Implemented: #62 reviewed session-validation fallback

The pinned SDK (`ebb8205`) exposes read-only session estimation. Only a canonical
account-validation rejection captured by its estimation RPC produces
`validation: "account-rejected"`; submission errors, provider text, signature
placeholder rejection and unavailable estimates cannot produce that decision.
The check creates no durable operation or installation state and does not sign.

For multi-operation chains with an owner available, Moesi's `signer: "auto"`
uses this SDK result before selecting the owner. The accepted review reports
`session-validation-failed`, binds the exact Grant authority, and estimates every
owner operation. A changed validation result or Grant requires a new review.
Explicit session selection and required onchain enforcement never switch to
owner. Rechecking at submission preserves the durable fence on any failure;
there is no retry or signer change after a possible submission.

Validation: `pnpm check` passed (36 boundary tests and 634 package tests), and the
full packed OAAth consumer passed. New browser/local wallet fixtures inject a
session-estimation rejection, execute two owner operations through the real
local EntryPoint, verify convergence, recreate SDK instances and observe both
original references without new signatures or submissions. Unavailable
estimation blocks before owner consent. The successful cold two-operation path
uses 581 SDK HTTP requests before recreation for each wallet fixture, within the
SDK's default 1,000-request bound. The fixture's former 500-request bound was
insufficient; its new request counter records this cost. Full-fleet request and
latency budgets remain a separate developer-workflow requirement.

The SDK's 28 focused tests and nine local Anvil tests also pass, including
sequential owner operations, with typechecks, lint, package boundary checks and
builds. These are local fault-injection and real-contract execution proofs;
they do not claim live Monad submission or wallet-extension UI coverage.

## Implemented: observation without starting pending work

`MoesiResumeRequest.mode` now separates explicit continuation from automatic
confirmation. `observe-only` withholds the pending-operation executor at the Run
owner: it performs no provider review, preparation or submission. Existing
references may finalize; untouched work retains its exact record and returns
`pending-execution`. The CLI exposes `resume --observe-only` without requiring
viem keys for pending work. Default resume retains its normal preflight and
continuation behavior. Result versions are `moesi.run-result/v8` and
`moesi.cli-run-result/v10`; the durable Run schema is unchanged.

The negative regression previously started pending work. Core and CLI tests now
cover pending preservation, existing-reference observation, malformed modes,
and CLI argument/key handling. The packed library proof recreates the process
for untouched, partially executed, and atomic runs, with zero recovery
submissions. The local Anvil CLI proof finalizes the retained transaction in a
new process using observe-only mode and verifies that the sender nonce did not
increase. The full repository check and packed library/CLI checks pass.

Orchestra Activity still needs to consume this API and prove recovery through
its browser and application journals. This core boundary alone does not prove
that application integration.
