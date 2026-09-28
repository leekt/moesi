# Developer workflow implementation

This work implements Moesi issues #58–#62 and checks the developer paths they
affect. Implementation and required validation run together; there is no
separate review phase or independent-review gate.

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

- #62: local session orchestration for existing Kernel v3.3 and automatic owner
  selection after a conclusive session-validation failure. Owner execution,
  browser/local wallets, and conclusive bundler-rejection routing are implemented
  below. Further OAAth changes must arrive as exact packed artifacts, never
  source imports.
- Developer paths: exercise packed library and CLI usage, authorization,
  recovery, cancellation, fleet status, migration, and app composition as the
  corresponding changes land. Carry forward the existing diagnostics/probe
  fixes from the original working tree without overwriting that work.

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
