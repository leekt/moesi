# @moesi/oaath

## 0.15.4

### Patch Changes

- Pin published Cetane 0.0.4 across runtime packages and packed consumers. Kernel
  0.4.0 module inventories can now report complete coverage when known permissions,
  selectors and hook scopes reconcile with installation history; unknown contexts,
  partial history and exhausted read budgets remain incomplete.

## 0.15.3

This pre-1.0 patch includes breaking API and persisted-artifact changes. Use
`moesi/cetane` and `--provider cetane`; recreate old manifests and reviews.
Observe unresolved Runs with the release that created them, never resend them
through a newly selected provider. Sibling Moesi packages must be at least
`0.15.3`.

### Patch Changes

- e89370d: Declare account module expectations and detect state-confirmed extra or changed authority through a hash-pinned Cetane inventory. Retain history counts and incomplete coverage separately, bind explicit removal self-calls to reviewed plans and verify fresh module state after execution. CLI outputs include the evidence.

  Breaking: manifests use v7, reviewed plans v8, verification results v5, run results v8, deployment runs v10, fleet observations v3 and CLI execution reviews/results v9/v10. Recreate older artifacts. Cetane is pinned to 0.0.3. Unknown permission/selector/hook history never proves convergence; removals require an explicitly selected smart-account-capable provider.

- 20708eb: Replace Moesi's runtime viem dependency with Cetane. The public provider and
  observation entry point is now `moesi/cetane`, with `createCetaneObserver`,
  `createCetaneObservationAdapter`, and `createCetaneExecutionProvider`. The CLI
  requires `--provider cetane` for ordinary EOA execution. The old subpath and
  provider names are removed.

  Ordinary local wallets use Cetane's frozen EVM execution module, explicit
  `nativeAA: false`, a plain address account and a separate signer. RPC-owned
  wallets use `createRpcWalletClient`. Native-AA or custom execution modules are
  rejected by the ordinary provider. Cetane's local EOA engine emits EIP-1559
  transactions, so the CLI does not support legacy-only chains. RPC-owned wallets
  select their transaction format. Provider reviews and transaction references
  bind the new provider identity; old viem reviews cannot authorize Cetane sends.

  Read pins, cancellation, bounded observation retries, finality checks and the
  no-resend boundary are retained. `createHttpTransport` now returns a Cetane
  transport object and takes `fetch` and `headers` options; it never retries.

  The workspace and consumers use the published `cetane@0.0.3` release, including
  the required ABI, address, RPC-wallet and capability-read additions. The pinned
  OAAth SDK still uses viem internally; Moesi does not replace its credential or
  submission implementation.

## 0.15.2

## 0.15.1

## 0.15.0

### Minor Changes

- 0e16012: Compile contiguous configuration rows into bounded calls containing only drifted,
  ready rows. Preserve an exact postcondition for every row. Add literal cross-chain
  peer prerequisites with pinned evidence, pending/blocked readiness, and fresh
  runtime and lineage checks before submission and during convergence verification.
  The CLI accepts read-only `--peer-chain` bindings and displays peer readiness.

  Breaking persisted versions: manifest v6, reviewed plan v7, deployment run v7,
  verification/run result v4, and CLI plan/execution-review/run-result wrappers v6.
  Regenerate old artifacts. Steps now contain `configurationIds` arrays (empty for
  deployments); reviewed plans require `peers` evidence, and plan disposition adds
  `pending`. No previous-schema reader or in-place artifact migration is provided.

- 0e16012: Compile one OAAth permission from heterogeneous fleet plans and map a manifest's
  logical account name to an existing SDK account. Permission compilation and
  requests now take `plans: [plan]` instead of `plan`; up to 32 distinct plans can
  share one approval. The per-chain operation limit covers aggregate operations
  across all supplied plans. An insufficient existing grant is retained and rejected
  without requesting replacement permission.

  Pass the same `account: { address, accountId }` to permission
  requests and the execution provider. The CLI forwards this binding from the
  caller-owned client module. The SDK's native identity remains bound into the
  provider review. Account or authority changes invalidate execution acceptance.

- 48a06b1: Require `@oaath/sdk@0.3.0` and read SDK reviews through its versioned
  `oaath-calls-review-v1` contract. Semantic fields (signer, enforcement,
  validation, fallback condition and fee payer) stay closed and checked; account
  implementation and submission route are opaque identity bound into the review
  fingerprint. A new Kernel version or submission route needs no adapter release,
  and any change to one still invalidates an accepted review.

  Breaking: the `sender` option is removed. Submission routing belongs to OAAth.
  Pass an optional `payer` in the SDK's own `OaathPayer` shape instead; it is
  forwarded unchanged to every review and send. Handle-ops fallback now requires
  `payer: { kind: "connected-eoa", wallet }` and is no longer enabled implicitly
  by supplying `owner`. `{ kind: "paymaster-service", ... }` requests sponsorship.
  `owner` accepts any SDK owner key. Unknown provider options fail with
  `oaath_input_invalid`. Windowed SDK operation limits count their per-window
  `count`. Provider review routes and reason codes now carry the SDK's route kinds
  (for example `oaath-session-erc4337-bundler:…`, `oaath_route_available:erc4337-bundler`),
  so reviews accepted under 0.2.0 must be recreated.

- bde6811: Add an optional `lane` to `createOAAthExecutionProvider`, in the SDK's own
  `OaathOperationLane` shape, so a receipt-unknown run on one caller-reserved
  session lane no longer blocks the next run on another. Lanes are session-only:
  a laned provider never selects owner signing, and `signer: "owner"` with a lane
  fails with `oaath_input_invalid`. The lane is bound into the accepted review and
  retained in each operation reference, so `resume` needs no lane configuration.
  Moesi core is unchanged.

  Operation references move to `oaath-op-v3`, which names the lane (`default` or
  `lane.<nonceKey>.<id>`). References retained as `oaath-op-v2` are unsupported and
  observe as `invalid-evidence`.

- 0e16012: Support existing Kernel v3.3 owner execution through the public OAAth owner
  client, selecting owner signing for an estimated single chain operation.
  Expose the reviewed fallback policy and the actual finalized submission route.
  Owner recovery opens the saved operation without a wallet or new permission.

  Breaking: execution reviews use v3, deployment Runs v9, and run results v6.
  CLI review/result outputs use v8 and status uses v3. Recreate older artifacts.
  OAAth operation references use v2 with an explicit owner/session context.
  CLI `openOAAth()` modules now return provider options `{ oaath, account?, owner?,
signer?, sender? }` instead of a bare SDK client.

  Local session orchestration and fallback from conclusive session-validation
  failure remain pending; an unavailable owner estimate blocks without signing.

- 0e16012: Execute each chain's reviewed steps as one atomic operation when the selected
  provider implements `submitBatch`. Bind packing, signer and sender before
  execution; preserve the exact call order and reject partial or altered evidence.
  OAAth reviews and sends complete batches, and grant limits count operations.
  The direct viem provider remains per-step.

  Breaking: execution reviews use v2 with required packing and signer facts;
  deployment Runs use v8 operation records with ordered step membership; run
  results use v5 operation evidence. CLI review/result, status and permission
  outputs use v7, v2 and v2 respectively. Recreate previous persisted artifacts.
  Provider review and prepare now receive the selected packing. Replace step
  record/evidence consumers with operation record/evidence consumers.

  Resume observes one retained batch reference without resubmitting any calls.
  Only an entirely satisfied configuration operation may be skipped. Runtime
  dependencies created within an atomic operation are verified after execution;
  per-step packing retains intermediate checks. Owner signing and Kernel v3.3
  execution remain separate work under #61/#62.

- 0e16012: Support sender-protected CreateX CREATE2 and CREATE3 from exact smart-account
  senders, including offline address prediction through `predictManifestAddresses`.
  CREATE3 reproduces the existing SRA Across adapter and resolver addresses.

  Breaking: smart-account manifest senders and reviewed-plan sender requirements
  now require a concrete `address` alongside `accountId`. Provider review verifies
  both, and configuration reads use this exact address. Replace
  `deriveCreateXCreate2RawSalt` with `deriveCreateXSenderProtectedRawSalt`.

  Manifest, reviewed-plan, and deployment-run versions advance to v5. CLI plan,
  execution-review, and run-result wrappers advance to v4. Recreate old persisted
  artifacts; no compatibility reader or in-place migration is provided.

- 0e16012: With an owner wallet and `signer: "auto"`, review the session estimate for
  multi-operation chains and select owner execution only after the SDK reports a
  conclusive account-validation rejection. The immutable decision includes the
  Grant authority and the reason `session-validation-failed`; changed facts need
  a new review before signing. Explicit session selection and required onchain
  enforcement never fall back. Unknown estimates and ambiguous submission failures
  remain blocked and never authorize a resend.

  The exact pinned development SDK now requires a structured `validation` result
  from Grant review. This is a breaking public SDK boundary change; older review
  objects are rejected. No persisted Moesi shape changes.

  Local packed fixtures inject the bundler's estimation rejection or unavailability
  and execute successful owner operations through a real local EntryPoint. These
  checks do not claim live Monad execution or wallet-extension UI coverage.

- 0e16012: Add `createViemObserver` in `moesi/viem`: configure URL pools instead of writing
  RPC failover, timeout, concurrency, and block-pin code. Reads retry only allowed
  failure categories and preserve the exact canonical block hash and caller.
  Use `batch: true` for JSON-RPC batching with caller semantics intact. Defaults
  are three attempts, ten seconds per HTTP request, and eight concurrent reads.

  `plan` and `verify` accept an `AbortSignal`. Each chain captures its snapshot
  immediately before its reads; optional `{ lagBlocks }` selects a fresh lagged
  pin. Same-stage checks run concurrently, retaining the first unreadable result
  in canonical order. Cancellation never becomes a missing or drifted resource.

  Unreadable cells and snapshot errors preserve bounded structured causes:
  endpoint index, failure category, HTTP status, and RPC code. Raw provider errors,
  messages, abort reasons, and credential-bearing endpoint URLs are excluded.

  Breaking persisted formats: reviewed plans and deployment runs advance to v6,
  verification and run results to v3, and CLI plan/execution-review/run-result
  wrappers to v5. CLI error output advances to v2 to include safe causes. The
  manifest remains v5. Recreate old artifacts.

### Patch Changes

- 0e16012: Bound viem snapshot ancestry checks to three canonical block reads, independent
  of receipt or plan age. Check both exact hashes and recheck the descendant
  after the ancestor; reject contradictory adjacent parent linkage and changed
  chain identity. Equal-height pins now require a canonical lookup too. Remove
  the 4,096-block age limit and linear parent-hash walk. This uses configured
  RPC canonicality, not local consensus verification; state reads retain their
  exact EIP-1898 block pins.

  Use the exact OAAth d1b7ab9 packages, whose receipt finality checks likewise
  have a bounded canonical read set. Packed owner/session recovery tests now
  resume after 1,024 additional blocks. Provider verification and deployment
  convergence remain separate checks. No persisted Run or review shape changes.

- 8981c0b: Migrate repository installs, workspace commands, packing, and CI to Bun 1.4.2.
  Use `bun install --frozen-lockfile --ignore-scripts` and `bun run check` when
  contributing. The published libraries and CLI retain their Node >=22.13 runtime
  support; Bun is required only for repository development.
- 0e16012: Pin the exact OAAth SDK artifacts that add issuer-free local sessions for existing
  Kernel v3.3 accounts. The same client supports browser/local owner wallets and
  scoped session execution. Document composition, durable recovery, silent Grant
  reuse and SDK-owned revocation. Add a packed Moesi consumer covering atomic cold
  deployment, reopening before observation, drift repair and final disconnect.
- b25171b: `createOAAthExecutionProvider` now rejects an explicit `signer` the supplied
  client cannot provide with `oaath_input_invalid` at construction, instead of
  blocking later at review. `signer: "session"` needs a connectable client;
  `signer: "owner"` needs an owner client and `account`. A wallet-less owner
  configuration stays valid for recovery-only observation. Unknown `account`
  binding fields are now reported as `oaath_input_invalid` rather than
  `oaath_sdk_invalid`.
- 0e16012: Adopt upstream's direct local Grant authorization path while retaining combined
  owner execution, local-wallet signing and cleanup fixes. Update the documented
  SDK local input to `account: address`; the Moesi provider's account descriptor
  remains unchanged. Pin the exact SDK artifacts with packed browser and Moesi
  consumer evidence.
- 0e16012: Pin exact OAAth development artifacts with the existing Kernel v3.3 Grant
  runtime. The packed adapter consumer now proves one all-chain permission,
  atomic deploy/configure batches, recreated SDK and Run recovery, and a second
  reviewed configuration plan using the installed session without new consent.
  Issuer-free session composition and automatic owner fallback after conclusive
  session-validation failure remain separate work.

## 0.14.0

### Minor Changes

- a22056f: Add the optional public-SDK OAAth execution provider. Explicitly request or reuse
  one all-chain permission, review actual signer/route/enforcement, submit exact
  reviewed actions, and recover finalized SDK calls from durable references.
  The adapter requires `@oaath/sdk@0.2.0`; development uses exact checked-in
  artifacts from its reviewed source commit. Packed CLI recovery survives loss
  of the producing SDK process without another submission.
