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

- #59: finish the worked SRA migration against the actual 22-chain source data.
  Typed authoring, batching, pending peers, pinned reads, the migration guide,
  and the library/CLI parity comparison are implemented.
- #61: explicit per-chain operation batching and signer choice, durable batch
  recovery, one-UserOp owner path.
- #62: existing Kernel v3.3, browser/local owner and session flow, and conclusive
  pre-acceptance routing fallback through the public OAAth SDK. Any necessary
  OAAth changes must arrive as exact packed artifacts, never source imports.
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

#59 remains in progress. The following sections record completed authoring and
parity comparison; real-fleet migration acceptance remains.


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
