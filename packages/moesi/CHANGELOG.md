# moesi

## 0.15.1

### Patch Changes

- 56daff0: Support chain-bound (EIP-155) Nick's-method signatures through an explicit
  `chainId` parameter, which requires `v` of `2 * chainId + 35` or `+ 36`.
  Chain-bound signatures without `chainId` now fail with the typed
  `chain_bound_nicks_signature` code, and mismatched bindings with
  `nicks_chain_mismatch`. `nicksSignatureChainId(v)` classifies stored
  signatures for migration, and `validateNicksAddress` results include the bound
  `chainId` (`null` when chain-neutral).
- ddb0be3: Add the crosschain-protected `createx-create2-crosschain-v1` and
  `createx-create3-crosschain-v1` strategies and the sender-and-crosschain
  `createx-create2-sender-crosschain-v1` and `createx-create3-sender-crosschain-v1`
  strategies. Each declares one exact `chainId`, because CreateX mixes
  `block.chainid` into the guarded salt. Planning on any other chain fails with
  the new `chain_bound_resource` planning code, reviewed plans and fleet parity
  reject foreign-chain cells, and `moesi inspect` prints the bound `chainId`.
  Addresses are proven against the pinned CreateX runtime on local Anvil. The
  manifest version is unchanged because existing manifests still parse.
- bc118cd: Add `serializeManifest(manifest, { format: "json" | "yaml" })`, which validates
  a manifest and writes canonical `moesi.manifest/v6` text that
  `parseManifestText` round-trips to the same manifest hash and predicted
  addresses. Add `deriveRuntimeCodeHash(runtimeCode)` and
  `observeRuntimeIdentity({ observer, chainId, address, expectedRuntimeCodeHash? })`
  to author `expectedRuntimeCodeHash` from compiler runtime bytes or pinned
  observed code. No persisted schema changes.

## 0.15.0

### Minor Changes

- 0e16012: Add `prepareSolidityArtifact` for full Foundry, solc contract-output and Hardhat 3
  artifacts. It captures compiler inputs, links creation/runtime library slots,
  encodes exact constructor arguments and produces literal manifest bytes with
  compiler/init-code provenance. Static runtime hashes come from the compiler;
  immutables and library self addresses require explicitly supplied, init-code-bound
  runtime evidence. Unknown formats, missing runtime metadata, malformed references,
  bad arguments and mismatched runtime bytes fail with structured field diagnostics.

  The helper validates supplied runtime evidence; it does not execute constructors
  or claim to authenticate the compiler or deployment context. Incomplete old
  application artifact exports must be regenerated from full compiler output.

- 0e16012: Add `compileDeploymentRecipe` for offline registration and authoring previews.
  It captures the current closed deployment/sender shape and shares the manifest
  parser, address predictor and calldata compiler with reviewed planning. Protected
  CreateX recipes require an exact owner or smart-account sender. The result is
  immutable authoring data; it does not fabricate a runtime expectation, observe
  chain state or authorize execution.
- 0e16012: Add versioned durable fleet observations with pinned compiler reads, retained
  complete evidence during failures, explicit partial observations, cancellation,
  and revision-based publication that prevents stale scan completion. Export the
  store contract, memory store and per-chain scanner from `moesi/fleet`, and the
  Node SQLite store from `moesi/node`. Old observation formats are not migrated.
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
- 0e16012: Reserve observation revisions before compiling live-dependent manifests.
  `observeFleetChain` now takes a `definitionHash` and asynchronous `prepare`
  callback instead of a previously compiled manifest. This prevents an older,
  slower compilation from overwriting a newer scan and persists compiler failures
  and cancellation while retaining prior complete observations. Observation
  records are now `moesi.fleet-observation/v2`; v1 records must be recreated.
- 0e16012: Allow `fleet.compile({ chains })` to select source chains without removing peer
  chains from its resource catalog. This supports independent single-chain scans
  without compiling every source or making unrelated live reads.
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

- 0e16012: Add `moesi/fleet` with ABI-typed configuration rules, per-chain resource and
  configuration callbacks, explicit account/resource references, resource filters,
  and grouped literal plan inputs. Live cross-chain reads retain exact block pins,
  deduplicate requests, validate ABI return data, and propagate bounded causes and
  cancellation. Support canonical tuple-array batch parameters for asset-fee rows.
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
- 0e16012: Share a bounded cooldown across reads to a throttled RPC endpoint instead of
  immediately repeating rate-limited requests. The default delay is 500 ms and
  doubles per retry up to five seconds; library callers can set
  `retry.rateLimitDelayMs`. Other endpoints remain available for immediate
  failover. Cancellation interrupts cooldowns without issuing another request,
  and retries preserve the exact block pin and caller.
- 0e16012: Fix probe evidence and preserve unknown results. Opcode probes use bounded,
  isolated state overrides without a deployed factory; transport failures no
  longer imply an unsupported opcode. Code checks exclude their temporary helper
  and omit unreadable fallback results. Feature probes validate exact response
  shapes, precompile output, and structured RPC method errors. PREVRANDAO and
  EIP-7702 remain inconclusive when simulation cannot establish activation.

  Breaking before 1.0: probe input bounds, exact records, unique IDs, immutable
  results, and the supported/unknown outcome union are enforced at the boundary.
  Nick's-method helpers require chain-neutral legacy signatures, valid curve
  scalars, and positive gas; signature quantities use canonical RLP encoding and
  failed recovery never exposes serialized transaction data.

## 0.14.0

### Minor Changes

- f0f95e7: Add `compileCheckedBeaconProxy` for the pinned checked beacon/proxy family. The compiler produces ordinary current manifests with deterministic CREATE2 creation, fixed constructor identity, exact EOA owner requirements, typed beacon/owner assertions and runtime-checked upgrade calldata. Constructor guards prevent initialization through an unexpected beacon implementation. Guarded upgrades require exact nonempty implementation code; unguarded upgrades revert. Generated bytecode is reproducible from OpenZeppelin Contracts 5.6.1 and solc 0.8.30, with source/hash/license provenance.

  Changing the desired implementation preserves beacon/proxy addresses. Initializer semantics and storage-layout compatibility require explicit caller review; this does not support arbitrary existing proxies, UUPS, transparent proxies or upgrade-and-call migrations. No persisted schema changes or compatibility paths.

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

- 35147c9: Add `createMoesi({ observer }).discover()` for explicit contract addresses across selected chains. The immutable `moesi.discovery/v1` result reports runtime code and optional ERC-1967 slot, Ownable owner, and AccessControl role evidence at pinned blocks, with a final ancestry check. Missing, malformed, unavailable, and contradictory evidence remain distinct. Discovery has no execution provider or permission side effects and does not infer proxy authenticity, enforcement, or repair actions.
- c6ea95f: Replace the old deployer APIs with the incompatible provider-neutral Moesi design, without compatibility shims or an OAAth implementation.
