# @moesi/cli

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

- Updated dependencies [e89370d]
- Updated dependencies [b6ffc2c]
- Updated dependencies [20708eb]
- Updated dependencies [704d1db]
- Updated dependencies [4ca44ec]
  - moesi@0.15.3

## 0.15.2

### Patch Changes

- 81d9dd7: Add Multicall3 batching for EOA deployments. `encodeMulticall3Aggregate(calls)`
  packs value-free reviewed calls into one `aggregate` call, next to
  `MULTICALL3_ADDRESS` and `MULTICALL3_RUNTIME_CODE_HASH`. The viem provider now
  supports explicit `packing: "per-chain"` (and `moesi apply --provider viem
--packing per-chain`) by sending each chain's steps as one Multicall3
  transaction. Review allows it only for sender-independent, value-free chains
  with the canonical Multicall3 runtime, submission re-attests that runtime
  before signing, and evidence decodes the exact inner calls. Providers can
  declare `defaultPacking`, and the viem provider keeps `per-step` as its default.
- f3e6cc4: Add credentialed RPC endpoint handling to `moesi/viem`: `rpcEndpoint(url)`
  moves Basic-auth userinfo into an `Authorization` header, `redactRpcUrl(url)`
  removes userinfo, known API-key query values and `/v3/<key>` path segments, and
  `createHttpTransport(url, options)` sends those headers and scrubs every request
  failure into `MoesiRpcTransportError`. `createViemObserver` now accepts
  credentialed `rpcUrls`, and CLI signing transports use the scrubbing transport.
- Updated dependencies [81d9dd7]
- Updated dependencies [f3e6cc4]
  - moesi@0.15.2

## 0.15.1

### Patch Changes

- ddb0be3: Add the crosschain-protected `createx-create2-crosschain-v1` and
  `createx-create3-crosschain-v1` strategies and the sender-and-crosschain
  `createx-create2-sender-crosschain-v1` and `createx-create3-sender-crosschain-v1`
  strategies. Each declares one exact `chainId`, because CreateX mixes
  `block.chainid` into the guarded salt. Planning on any other chain fails with
  the new `chain_bound_resource` planning code, reviewed plans and fleet parity
  reject foreign-chain cells, and `moesi inspect` prints the bound `chainId`.
  Addresses are proven against the pinned CreateX runtime on local Anvil. The
  manifest version is unchanged because existing manifests still parse.
- Updated dependencies [56daff0]
- Updated dependencies [ddb0be3]
- Updated dependencies [bc118cd]
  - moesi@0.15.1

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

- 0e16012: Add `parseFleetBaseline` and `checkFleetParity` to `moesi/fleet`, and the read-only
  `moesi check-parity` command. Compare independent resolved fleet declarations
  with compiled manifests and re-observe both at shared block pins, retaining
  address, runtime, configuration, attestation, storage, peer-readiness and safe
  failure evidence. Version baseline and report artifacts explicitly. Return
  distinct match, difference and unreadable results; a parity match does not imply
  deployment convergence. Document exporting an independent 0.9 application
  baseline and checking each compiled fleet group without a signer or Run store.
- 4136a71: Add `resume({ mode: "observe-only" })` and `moesi resume --observe-only` for automatic
  confirmation without starting untouched work. Existing references can finalize;
  pending operations retain their durable state and return `pending-execution`.
  Default resume still continues untouched work after normal preflight.

  Run results now use `moesi.run-result/v7`, and CLI result envelopes use
  `moesi.cli-run-result/v9`. Update consumers to these current versions; durable
  Run records keep their existing schema.

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

- 8981c0b: Migrate repository installs, workspace commands, packing, and CI to Bun 1.4.2.
  Use `bun install --frozen-lockfile --ignore-scripts` and `bun run check` when
  contributing. The published libraries and CLI retain their Node >=22.13 runtime
  support; Bun is required only for repository development.
- 0e16012: Preserve authorization and execution outcomes when runtime cleanup fails. Apply,
  resume, and authorize now report a scrubbed secondary warning on stderr instead
  of replacing the original error or changing an already-rendered result's exit
  code. JSON warnings use `moesi.cli-warning/v1` with `runtime_cleanup_failed`.
- 0e16012: Add offline command-specific help, safe actionable diagnostics, and recovery
  guidance for viem and OAAth execution. `plan --out <path>` atomically saves the
  exact plan artifact with private permissions and refuses to replace an existing
  file. JSON/YAML stdin remains supported; missing option values fail before I/O.

  Human execution results report actual operations and fresh resource evidence
  without repeating the review's not-started state. Interactive runs show execution
  and safe-stop progress. JSON artifact shapes and execution acceptance are unchanged.

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

- 0e16012: Share a bounded cooldown across reads to a throttled RPC endpoint instead of
  immediately repeating rate-limited requests. The default delay is 500 ms and
  doubles per retry up to five seconds; library callers can set
  `retry.rateLimitDelayMs`. Other endpoints remain available for immediate
  failover. Cancellation interrupts cooldowns without issuing another request,
  and retries preserve the exact block pin and caller.
- Updated dependencies [0e16012]
- Updated dependencies [8981c0b]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [4136a71]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
- Updated dependencies [0e16012]
  - moesi@0.15.0

## 0.14.0

### Minor Changes

- 1c640e6: Resolve explicit resource-address-word expressions and nonrecursive hex
  concatenation in configuration and attestation byte fields before observation.
  Reviewed plans retain only exact literal bytes; references never infer runtime
  dependencies or provider identity. Export source expression types and
  `ResolvedMoesiManifest` for canonical literal manifests.

  Recreate stale artifacts; unsupported versions are rejected before field
  diagnostics, with `unsupported_run_version` and
  `unsupported_plan_artifact_version` added for Run and CLI plan boundaries.
  There are no compatibility readers. Unknown resource IDs produce
  `unknown_reference`; malformed expression objects produce `invalid_reference`.

- 8e525b1: Add closed manifest `semanticChecks` for Ownable ownership, AccessControl membership/admin roles, and ERC-1967 direct/beacon proxy expectations. Planning compiles exact read-only assertions with explicit semantic kinds and call targets. The plan codec binds those assertions to the manifest; planning and fresh verification reject malformed ABI words as unreadable. These assertions produce no repair calls or authority. CLI review/inspection/verification show their kinds and targets.

  Breaking artifact change: manifest, reviewed-plan, and deployment-run versions are v4; CLI plan, execution-review, and run-result versions are v3; core verification-result and run-result versions are v2. Recreate stale artifacts and review again. No compatibility readers or in-place upgrades are provided.

- ad23cdc: Add `parseManifestText` for one bounded JSON or YAML 1.2 document, and allow
  `moesi plan --manifest -` to read stdin. Equivalent data produces the same
  immutable manifest and plan. Quote YAML addresses, bytes, and decimal values.

  Manifest text now rejects duplicate keys, aliases, anchors, explicit tags,
  multiple documents, excessive nesting, and input larger than 1 MiB of UTF-8.
  Malformed syntax uses `invalid_manifest_document`, replacing the CLI-only
  `manifest_json_invalid` code; oversized input uses `manifest_source_too_large`.

- bc960d2: Add explicit optional OAAth selection with a caller-owned SDK module, a separate
  authorize command, review-bound apply and reference-only recovery. Viem and
  read-only commands do not load or require the adapter. Close SDK resources on
  every command outcome without revoking permission.

  Atomicity identifies one transaction per viem action or one SDK operation per
  OAAth action. Recreate old review artifacts; final artifact versions for this
  release are listed with the semantic-check changes above.

- c6ea95f: Replace the old deployer APIs with the incompatible provider-neutral Moesi design, without compatibility shims or an OAAth implementation.

### Patch Changes

- Updated dependencies [f0f95e7]
- Updated dependencies [1c640e6]
- Updated dependencies [8e525b1]
- Updated dependencies [ad23cdc]
- Updated dependencies [35147c9]
- Updated dependencies [c6ea95f]
  - moesi@0.14.0
