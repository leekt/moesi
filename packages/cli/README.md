# @moesi/cli

RPC observation uses Moesi's shared viem observer: ten-second full-request
timeouts, bounded retries, exact block-hash reads, and safe endpoint diagnostics.
Human output shows `rpc-attempts` for unreadable evidence; JSON retains
`cause.attempts` with endpoint indexes, categories, HTTP statuses, and RPC codes.
Error JSON uses `moesi.cli-error/v2`. Raw URLs and provider messages are excluded.

`@moesi/cli` is the deployment-focused command line interface for Moesi.

```sh
moesi plan --manifest ./moesi.json --chain 8453=https://rpc.example --json
moesi inspect --plan ./plan.json --json
moesi verify --plan ./plan.json --chain 8453=https://rpc.example --json
moesi apply --plan ./plan.json --provider viem --chain 8453=https://rpc.example \
  --signer 8453=MOESI_DEPLOYER_KEY --confirmations 2 --store ./.moesi/runs --json
moesi resume --run 0x... --provider viem --chain 8453=https://rpc.example \
  --confirmations 2 --store ./.moesi/runs --json
moesi status --run 0x... --store ./.moesi/runs --json
```

`plan --manifest` accepts JSON or YAML 1.2 regardless of the filename extension.
Use `--manifest -` to read one document from stdin:

```sh
cat moesi.yaml | moesi plan --manifest - --chain 8453=https://rpc.example --json
```

Both formats use the same current `moesi.manifest/v6` schema and produce the
same plan for equivalent data. Quote addresses, hex bytes, and decimal value
strings in YAML. Input is limited to 1 MiB of UTF-8. Duplicate keys, aliases,
anchors, explicit tags, multiple documents, and excessive nesting are rejected
before any RPC access. Invalid syntax emits `invalid_manifest_document`;
oversized input emits `manifest_source_too_large`. Neither includes source text.

Configuration and attestation byte fields also accept explicit
`resource-address-word` and `concat` expressions described in the
[core manifest reference](../moesi/README.md). References resolve before RPC;
plan/inspect/review output contains only exact bytes. Unknown IDs return
`unknown_reference`. The current manifest schema is v5, reviewed-plan and
deployment-run schemas are v6, and the CLI plan wrapper is v5. Recreate stale artifacts; the
CLI reports `unsupported_plan_artifact_version` or `unsupported_run_version`
when their outer persisted versions are stale.

Use manifest `semanticChecks` for explicit owner, role and ERC-1967 expectations
as described in the core reference. Plan, inspect, execution review and verify
retain semantic kinds and exact beacon call targets. These assertions are
read-only; only separate managed configuration rules generate repair calls.
Execution-review and CLI run-result artifacts are v3; embedded core Run and
verification results are v2. Recreate prior reviews before execution.

Repeat `--chain` for multiple chains. Planning exits 0 for converged, 2 for
changes, and 3 for blocked or partial state. Verification exits 0 for converged,
2 for drifted, and 3 for unreadable. Invalid input exits 1. RPC URLs and raw
provider diagnostics are not printed.

`inspect` strictly reads and reparses one `moesi.cli-plan/v6` artifact, then
prints its complete normalized manifest, pinned snapshots, canonical factory
capabilities, runtime and configuration cells, ordered steps, exact calls,
postconditions, and provider-neutral execution requirements. It performs no
RPC or other network access and needs no execution provider, signer,
environment access, Run store, or signal handler. Every valid plan disposition
exits 0. JSON output is the canonical `moesi.cli-plan/v6` wrapper.

Runtime code is read with `eth_getCode`; managed configuration and read-only
call checks use `eth_call`, while storage checks use `eth_getStorageAt`. All use
the captured block hash with `requireCanonical: true`. A call check sends
exactly `{ from: caller, to: resourceAddress, data: readData }` plus that
EIP-1898 block selector. A storage check sends exactly three parameters: the
resource address, canonical 32-byte slot, and the EIP-1898 selector. Neither
supplies a signer or execution route.
Every RPC binding is first matched to its declared chain with `eth_chainId`.
Configuration drift is emitted as reviewed remediation calldata; unreadable
configuration evidence blocks planning.

Every manifest resource is explicitly `managed` or `external` and declares
exact read-only `checks` (id, simulation caller, calldata, expected result) and
`storageChecks` (id, 32-byte slot, expected word). Managed resources may also
own deployment and repairable configuration work. Attestation-only managed
drift is blocked; configuration-only drift is actionable; mixed drift is
partial and contains only the configuration calls. External resources remain
verify-only and contribute no factory capability, repair call, step, execution
requirement, sender, or enforcement authority.
Human plan, inspect, verify, and first-pass apply-review output preserve the
resource kind. Inspection uses generic `manifest-call-check`, `call-check`,
`manifest-storage-check`, and `storage-check` labels with explicit observation
and mismatch lines for either kind. First-pass apply JSON retains every exact
reviewed call and storage check, and human review prints its definition,
observed mismatch or unreadable reason, `remediation=none`, and
`execution-authority=none` before approval. Literal checks can express
owner/admin calls or proxy slots. Explicit `semanticChecks` retain their typed
expectations, without claiming inferred upgrades or repair authority.

Every managed deployment must declare `requiresRuntime`; use
`requiresRuntime: []` when it has no prerequisite. Each ID gates deployment on
exact same-chain runtime identity only. Missing managed prerequisites are
scheduled before dependents, while missing, wrong-code, or runtime-unreadable
targets leave the dependent blocked. Later storage, call, or configuration
drift does not broaden this runtime-only edge. Human plan, inspect, and
first-pass apply review show the exact IDs and whether a missing deployment is
scheduled or blocked.

`verify` strictly reads a `moesi.cli-plan/v6` artifact and requires its chain
set to exactly match the supplied RPC bindings before making an RPC request. It
then captures fresh pinned snapshots and reports runtime, read-only call and
storage attestations, and configuration evidence directly from the
provider-neutral core verifier.
Verification needs
no execution provider, signer, environment access, Run store, or signal
handler. JSON output is the canonical `moesi.verification-result/v4` object.

The `create2-factory-v1` strategy uses the canonical Arachnid deterministic
deployment proxy. Human and JSON planning output retain the pinned factory
capability; unavailable or mismatched factory code blocks missing deployments
before signing.

The `createx-create2-v1` and `createx-create3-v1` strategies use the canonical
CreateX factory with exact 11-byte entropy and a required `owner-eoa` or
`smart-account` sender. Smart-account senders require both `accountId` and
`address`. Human plan, inspect, and first-pass apply output name the strategy;
offline inspect also shows the normalized entropy and exact sender, and
capability output distinguishes the CreateX factory from the Arachnid proxy.
Other guard modes must use their explicitly supported strategy kinds.

`status` reads the canonical append-only DeploymentRun revisions without RPC,
provider, or signer access. It reports execution progress and retained provider
references; semantic convergence is explicitly `not-recorded` because that
requires fresh chain observation. A missing or malformed store fails closed and
read-only status does not create the directory.

`apply` requires an explicit `viem` or `oaath` provider. For viem, `--signer` names an environment
variable containing a private key; private keys are never accepted as command
arguments or printed. The first invocation only renders the exact provider
review and exits 2. It creates no Run and submits nothing. A second invocation
must pass that review's `--accept-review` digest, which binds the exact plan,
sender, route, enforcement, confirmation policy, and local store identity.

Viem references retain both the transaction hash and reviewed confirmation
count. `resume` can therefore observe submitted work in a fresh process without
a signer or second send. If untouched pending work remains reachable, signers
for the original reviewed requirements are required before it may continue.
There is no implicit provider or provider fallback.

The first SIGINT or SIGTERM requests a safe stop without deleting or
reclassifying durable progress. Handlers are removed after that request so a
second signal uses Node's default hard termination.


## OAAth execution

Install `@moesi/oaath` and its compatible public `@oaath/sdk` peer in the CLI's
application. For this development revision use the exact checksummed artifacts
in `vendor/oaath`; registry SDK 0.1.0 lacks the required APIs. The adapter is an
optional CLI peer and is imported only when OAAth is selected.

Supply `--oaath-client ./client.mjs`, an explicit local JavaScript module with
`export async function openOAAth()` returning your configured public SDK instance.
This module is application code and is executed when selected. It owns the SDK
realm, credentials and durable store configuration. Each invocation must reopen
the same realm/stores for review and recovery. The CLI closes the returned SDK
on completion; it never revokes authority or clears those stores.

```sh
# Explicitly request or reuse the plan's one all-chain permission.
moesi authorize --plan ./plan.json --provider oaath --oaath-client ./client.mjs --json

# Read-only provider review. No permission prompt or deployment submission.
moesi apply --plan ./plan.json --provider oaath --oaath-client ./client.mjs \
  --chain 8453=https://rpc.example --store ./.moesi/runs --json

# Repeat apply with --accept-review <reviewId> after reviewing that exact result.
# Recover its stored references through the same SDK realm.
moesi resume --run 0x... --provider oaath --oaath-client ./client.mjs \
  --chain 8453=https://rpc.example --store ./.moesi/runs --json
```

OAAth rejects viem's `--signer` and `--confirmations` flags; its public SDK owns
signing, submission and finality. Review exposes the actual session signer,
route, account and onchain enforcement. Changed authority invalidates the review
ID. Resume rejects another provider before opening its client and never requests
new permission. Pending or unreadable evidence cannot authorize another send.

`moesi.cli-execution-review/v6` and `moesi.cli-run-result/v6` distinguish one
transaction per viem action from one SDK operation per OAAth action. Moesi
separately verifies exact calls and deployment convergence. Older review IDs
must be recreated. `authorize --json` emits `moesi.cli-permission/v1` with only
the plan ID, requested/reused status and opaque Grant reference.

The packed proof runs the real CLI entry, requests permission, reviews without
sending, stops after a retained operation reference, reopens SDK/database handles,
and resumes to verified convergence with one submission. The fixture's backing
processes and in-memory database survive. A second packed test persists the SDK
and CLI Run state, kills the producer before observation, then starts a fresh CLI
process with the upstream read-only recovery client. It converges the same Run
and operation reference with an unchanged transaction count. This local fixture
proves direct-Grant recovery; applications still own their SDK persistence and
Anvil remains alive for the test.

### Read-only peer chains

When configuration uses `after` peers outside the plan's deployment chains,
provide their RPCs with `--peer-chain`. This flag works with `plan`, `verify`,
`apply`, and `resume`. A peer already covered by `--chain` reuses that binding.
Bindings must cover exactly the required peer chains; duplicate and unrelated
bindings are rejected. Peer-only chains do not require or accept signers.

```sh
moesi plan --manifest chain-1.json --chain 1="$CHAIN_1_RPC" \
  --peer-chain 10="$CHAIN_10_RPC" --json > plan.json
moesi verify --plan plan.json --chain 1="$CHAIN_1_RPC" \
  --peer-chain 10="$CHAIN_10_RPC"
```

Human output includes peer pins and each gated row's `ready`, `pending-peer`, or
`blocked-peer` readiness. A pending plan exits 3. JSON retains the same immutable
peer evidence and the exact row IDs covered by each batched call.
