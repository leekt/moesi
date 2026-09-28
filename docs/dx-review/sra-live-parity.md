# SRA migration acceptance, 2026-09-28

The actual 22-chain SRA authoring data compiles through `moesi/fleet`. All 22
comparisons match, and every candidate plan is converged at its recorded pins:
166 resource cells and 2,410 configuration rows, including route matrices,
asset fees, global fees, initiator permissions, feeds and owner/admin assertions.
All seven independently predicted managed addresses remain unchanged, including
Across at `0xAFdEA3e6716239482c2378a3bf6D24fBDd99B077`.

The built CLI also ran `check-parity` directly against Monad and its required
public peer RPCs with fresh pins. It exited 0 with `match` and a converged plan.
The Monad-to-Arc route returned the expected decimals. See the exact pins,
addresses, code hashes, plan IDs, resource counts and package/input hashes in
[the evidence](sra-live-parity-evidence.json).

## Inputs and method

- Application: [SRA PR #18 at `0726cbf`](https://github.com/zerodevapp/sra-dashboard/commit/0726cbf6654ee5d26aea7a8dcf734ce8bf68e3ff).
  The isolated checkout installed exactly `moesi@0.9.0` and
  `@moesi/settle-zerodev@0.9.0`, plus the current packed library under the
  `moesi-current` alias. Account/settlement functions were never invoked.
- Candidate: Moesi `f265a60`, unpublished package version 0.14.0, built and
  installed from an exact local tarball. The evidence records its SHA-256.
- Baseline: the application's original `computeExpected`, route generator,
  chain/token/alias registries, fee targets, initiator permissions, feeds and
  artifact ABIs. Baseline read bytes are encoded independently of the candidate
  manifest. This is not an old-schema reader in Moesi.
- Runtime identities: original creation artifacts, evaluated on local Anvil
  with the original constructor inputs. Thirty-nine distinct constructor
  contexts cover 144 managed cells. `SRAFactory` is deployed through the real
  CREATE2 proxy and original salt so its newly created child's immutable address
  is correct. Across's `wrappedNativeToken()` constructor dependencies are read
  at the recorded chain pins. SenderCreator's external identity is anchored to
  its pinned Ethereum code; every other chain is checked against that identity.
- Observations: public application RPCs, with an additional Arbitrum PublicNode
  endpoint. Each chain gets an exact block hash immediately before its reads.
  Successful observations are retained by chain, hash, target and caller for
  compilation and comparison. No read substitutes a newer block or a default
  value after failure. These are observations at the recorded pins, not a claim
  that the fleet remains converged later.

The full comparison required 2,620 distinct call reads and 210 code reads. Public
RPC throttling exposed two observer improvements: recognize `request limit
reached` diagnostics, including code `-32007`, and share a cancellable cooldown
before repeating requests to the same throttled endpoint. Both have local
regression tests. Mode was read with concurrency one; the other pools used eight.

The initial constructor-only `eth_call` produced an incorrect Factory runtime
hash because it used the wrong creation address. The corrected local CREATE2
deployment reproduces the live hash without adopting live bytecode as desired
state. The migration guide now describes this pitfall.

## Reproduce deliberately

These are manual acceptance fixtures, excluded from normal tests. They contact
public RPCs and only submit a transaction to their own local Anvil process.
They contain no signer credentials and perform no live transaction submission.

1. Use isolated checkouts of the application commit above and Moesi `f265a60`.
   Build Moesi and pack `packages/moesi` into `/tmp/moesi-sra-parity`. Install that
   tarball as `moesi-current` in the application alongside the exact 0.9.0
   dependencies. Keep the original application's dependencies isolated from the
   Moesi repository.
2. Save the code from [the pin capture](sra-pin-fixture.md) and
   [the comparison](sra-comparison-fixture.md) into the application's `scripts`
   directory. Their relative imports intentionally resolve against that exact
   application checkout. Run there with Bun 1.3.14 and Anvil available on PATH.
3. Invoke each through Moesi's `scripts/scrub-live-rpc-env.mjs` and
   `bun --no-env-file`, first the pin capture, then the comparison. This excludes
   inherited keys, RPC overrides and application dotenv files.
4. Inspect `/tmp/moesi-sra-parity/result.json`, `baseline.json`, and the manifest
   and parity files under `groups/`. A comparison rerun may reuse its local
   `observation-cache.json`; remove that task-specific cache for new live pins.
   Never present a cached run as a new observation.

The evidence establishes authoring, address/runtime identity, reads, peer
prerequisites and live parity. It does **not** establish OAAth authorization,
Kernel v3.3 execution, operation batching, owner/session signing or bundler to
handleOps fallback. Those remain separate implementation requirements.
