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

- #59: typed fleet authoring, per-chain variants, drift-only batch writes,
  pending peers, pinned cross-chain reads, migration guide, CLI parity check.
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
