# moesi

Persist fleet scans with `observeFleetChain` from `moesi/fleet` and the Node-only
`SqliteFleetObservationStore` from `moesi/node`. See [durable fleet observations](../../docs/fleet-observations.md)
for offline loading, retained evidence, concurrent scans and host integration.

## Reading a fleet through RPC URL pools

```ts
import { createMoesi } from "moesi";
import { createViemObserver } from "moesi/viem";

const observer = createViemObserver({
  chains: {
    56: { rpcUrls: [primaryBscUrl, backupBscUrl], pin: { lagBlocks: 20 } },
    480: { rpcUrls: [worldUrl], pin: "latest" },
  },
  timeoutMs: 10_000,
  concurrency: 8,
  batch: true,
  retry: { attempts: 3 },
});
const moesi = createMoesi({ observer });
const signal = AbortSignal.timeout(180_000);
const plan = await moesi.plan({ manifest, chains: [56, 480], signal });
const result = await moesi.verify({ plan, signal });
```

Each chain captures a fresh snapshot immediately before its reads. `"latest"`
captures the current head once; `{ lagBlocks }` captures a particular block
behind that head. Every subsequent read and retry uses the same block hash with
`requireCanonical: true`. Failover never silently switches a pinned read to
`latest` or converts missing historical state into absent code.

Defaults are three total attempts per logical read, ten seconds per HTTP
request, and eight active reads across chains. Each attempt verifies the
endpoint's chain ID before using it. Transport errors, HTTP 5xx, non-JSON
responses, rate limits, unavailable state, timeouts, incorrect chain IDs, and
malformed results can move to the next endpoint. `retry.on` restricts those
categories. Contract reverts and other RPC errors are terminal by default.
Rate-limited endpoints enter a shared cooldown before further reads: 500 ms by
default, doubling per retry up to five seconds. Set `retry.rateLimitDelayMs`
(1–5000 ms) to change the initial delay. A different endpoint can still be tried
immediately. Cancellation interrupts both the request queue and cooldown.

`batch: true` uses JSON-RPC batching, preserving every call's exact caller and
block hash. It does not route calls through a Multicall contract, which would
change `msg.sender`. Storage, call, and configuration checks run in bounded
groups; a failed stage prevents subsequent stages and execution, while reads
already in that stage may finish. Results retain canonical order.

`plan` and `verify` accept an optional `signal` and reject with
`MoesiObservationError` code `observation_aborted` when cancelled. The signal
also reaches the HTTP transport and queued reads. Injected observation adapters
receive the same signal; if they ignore it, Moesi stops waiting for them.

Unreadable statuses and `MoesiPlanningError.cause` carry safe diagnostics:

```json
{ "attempts": [{ "endpoint": 0, "category": "state-unavailable", "rpcCode": -32000, "httpStatus": null }] }
```

`endpoint` is the zero-based index in that chain's configured `rpcUrls` array.
Use it to identify the failing provider in your UI. URLs, provider messages,
request bodies, and abort reasons are excluded. Custom adapters can throw
`MoesiObservationError("observation_failed", cause)` using this validated shape.
Keep `createViemObservationAdapter` when you already own the viem client and
transport policy; the URL pool is available through `createViemObserver`.

Both viem observers attest snapshot ancestry with at most three canonical
block reads, regardless of the distance between snapshots. They read the exact
descendant height, check the ancestor height and hash, then recheck the
descendant; adjacent blocks must also have matching parent linkage. Equal-height
pins still require a canonical lookup. Chain identity is checked before and
after successful attestation. Missing or malformed headers fail closed.
These are facts attested by the configured RPC, under the same trust boundary
as pinned state reads, not a local consensus proof. A block lookup by arbitrary
hash alone does not establish canonicality. Provider finality and Moesi's
deployment convergence checks remain separate.

Provider-neutral onchain Terraform core. Public APIs are documented in the
repository [README](../../README.md).

```ts
import { createMoesi } from "moesi";
import { createViemExecutionProvider } from "moesi/viem";
```

Read-only deployment discovery accepts explicit chain IDs and addresses:

```ts
const result = await createMoesi({ observer }).discover({
  chains: [1, 10],
  resources: [{
    address: contractAddress,
    caller: simulationCaller,
    erc1967: true,
    ownable: true,
    roles: [{ role: roleBytes32, account: memberAddress }],
  }],
});
```

Each chain uses one pinned block for runtime code, the requested
[ERC-1967 slots](https://eips.ethereum.org/EIPS/eip-1967), and
[owner/role views](https://docs.openzeppelin.com/contracts/5.x/api/access).
A final fresh snapshot and ancestry check must confirm the original block
before its observations are returned. A failed check discards that chain's
data. Calls use the exact nonzero `caller`; discovery requires no provider,
wallet, grant, or Run store.

The frozen JSON-safe `moesi.discovery/v1` result sorts chains, addresses and
role/account pairs. A resource is `missing`, `unreadable`, or `deployed` with
runtime bytes/hash. Optional probes default off (`null` in output); explicit
roles default to an empty list. Strict ABI decoding distinguishes zero owner
or false membership from malformed/unavailable evidence. Beacon lookup runs
only when the implementation slot is zero and beacon slot is nonzero;
simultaneous nonzero values report `conflict`. No roles or accounts are enumerated.

Limits are 32 chains, 64 addresses, 32 role/account queries per address, and
4096 worst-case observation-adapter invocations (`MAX_DISCOVERY_READS`),
including snapshot/recheck calls. An adapter can use additional transport
requests internally. Invalid or oversized input fails before reads with
`invalid_discovery_request` or `discovery_budget_exceeded`.

These are reported storage/call facts. They do not prove a contract delegates
through those slots or enforces its owner/role reports. Discovery does not
infer desired state, grant authority, drift repairs, or upgrade calls.

Use `parseManifestText(source)` for JSON or YAML 1.2 text. It returns the same
immutable, normalized manifest as `parseManifest(object)` and can be passed
directly to `moesi.plan({ manifest, chains })`. Equivalent JSON and YAML produce
the same manifest hash and reviewed plan. The current schema is
`moesi.manifest/v6`; text parsing does not introduce another persisted format.

Text input is limited to 1 MiB of UTF-8 (`MAX_MANIFEST_TEXT_BYTES`) and one
document. Duplicate keys, aliases, anchors, explicit tags, non-string mapping
keys, non-finite numbers, and excessive nesting are rejected. Quote addresses,
hex bytes, and decimal value strings in YAML so they retain their required
string types. No templates, environment expansion, or executable tags run.
Malformed syntax returns `invalid_manifest_document`; oversized input returns
`manifest_source_too_large`. Parser diagnostics never include source text.

Manifest byte fields support two explicit expressions:

```json
{ "kind": "resource-address-word", "resourceId": "registry" }
{ "kind": "concat", "parts": ["0x11223344", { "kind": "resource-address-word", "resourceId": "registry" }] }
```

The first encodes a declared resource's address as a 32-byte ABI word. The
second concatenates literal hex and address words, with at most 256 parts and
no nested expressions. Use them in configuration `readData`, `writeData`, and
`expectedResult`; call-check `readData` and `expectedResult`; and storage-check
`expectedWord`. Output must still satisfy the field's exact byte constraints.
Deployment inputs, addresses, callers, senders, IDs, and values remain literal.

References resolve from deterministic managed addresses or declared external
addresses before observation. Forward references work; unknown IDs fail with
`unknown_reference`. No runtime dependency is inferred: declare `requiresRuntime`
separately when deployment needs another resource's code. Equivalent references
and literal bytes have the same canonical identity. `MoesiManifest` accepts
source expressions; `ResolvedMoesiManifest`, `ParsedManifest`, and reviewed plans
contain only literal bytes.

The manifest schema is v6, reviewed-plan schema is v7, and deployment-run schema is v9. Stale
artifacts must be recreated. Version checks precede field validation.

Every resource can declare `semanticChecks` (default `[]`), a closed read-only
set of desired owner, role and proxy facts. For example:

```json
{
  "kind": "ownable-owner",
  "id": "administrator",
  "caller": "0x1111111111111111111111111111111111111111",
  "expectedOwner": "0x2222222222222222222222222222222222222222"
}
```

Supported forms, each with a unique `id` of at most 96 characters:

- `ownable-owner`: `caller`, `expectedOwner`; reads `owner()`.
- `access-control-role`: `caller`, `role` (bytes32), `account`,
  `expectedMember` (boolean), `expectedAdminRole` (bytes32); reads `hasRole`
  and `getRoleAdmin` for those exact arguments.
- `erc1967-direct`: `expectedImplementation` and `expectedAdmin`; checks
  the implementation/admin slots and requires the beacon slot to be zero.
- `erc1967-beacon`: `caller`, `expectedBeacon`, `expectedImplementation`,
  `expectedAdmin`; requires the implementation slot to be zero, checks the
  beacon/admin slots, and calls `implementation()` at the declared beacon.

Addresses are literal. Callers, implementation and beacon addresses must be
nonzero; zero owner or admin and false membership are valid expectations.
Each resource permits at most 64 declarations. Generated check IDs append
`.owner`, `.member`, `.admin-role`, `.implementation`, `.admin`, `.beacon`,
or `.beacon-implementation` to the declaration ID. Collisions with explicit
check IDs or storage slots are rejected before observation.

Reviewed assertions retain their semantic kind, exact bytes, and call target.
The plan codec recompiles and matches every assertion against the manifest.
Address responses must be exactly one ABI word with zero upper bytes; boolean
responses must be exactly zero or one. Invalid responses are `unreadable`;
valid unequal responses are drift. Planning and fresh verification use the
same interpretation. Beacon calls always use the declared address, including
when the observed beacon slot has drifted.

Semantic drift blocks convergence and produces no writes. Only separately
declared managed configuration rules can authorize repair actions. An expected
owner or role is a view assertion, not an execution sender or grant. ERC-1967
checks attest slot/view values, not arbitrary delegation or upgrade safety.

`compileCheckedBeaconProxy(input)` is the supported beacon deployment and
upgrade compiler. It produces a frozen `{ manifest, beaconAddress, proxyAddress }`
using the existing current manifest schema and canonical CREATE2 factory:

```ts
import { compileCheckedBeaconProxy } from "moesi";

const compiled = compileCheckedBeaconProxy({
  id: "vault",
  beaconSalt,
  proxySalt,
  owner: reviewedOwnerEOA,
  implementations: [implementationV1, implementationV2],
  initialImplementationId: "implementation-v1",
  desiredImplementationId: "implementation-v2",
  initializationData,
});
const plan = await moesi.plan({ manifest: compiled.manifest, chains });
```

`implementations` contains 1–64 ordinary managed/external manifest resources,
including their dependencies. The selected IDs must exist. The compiler adds
`<id>.beacon` and `<id>.proxy` (the prefix has at most 120 characters), rejects
collisions, and generates exact owner and ERC-1967 beacon assertions. Both
resources require the explicit nonzero EOA owner in provider review. This first
family is for direct EOA execution; it does not claim OAAth owner compatibility.
Invalid compiler input returns `invalid_deployment` at `checkedBeaconProxy`
without input excerpts. The CLI can consume its literal manifest as JSON/YAML
by serializing `{ version: manifest.version, contracts: manifest.contracts }`.

The contracts extend OpenZeppelin Contracts **5.6.1**, compiled with solc
**0.8.30**, optimizer 200 runs and the Shanghai EVM target. Constructor and
runtime bytes are shipped with source, source hashes, settings and MIT notices.
`pnpm --filter moesi check:proxy-artifacts` recompiles and checks exact output;
`pnpm check` includes this gate. Runtime hashing patches the proxy's immutable
beacon address using compiler-produced offsets. OpenZeppelin's implementation
uses that immutable address for delegation, while the ERC-1967 beacon slot
remains separately verified.

Creation checks the exact initial implementation runtime onchain. The proxy
constructor additionally checks the beacon runtime and its current implementation
before delegating initialization. Initialization must contain 4–8192 bytes;
its function, arguments and storage effects remain the caller's review
responsibility. The initializer's `msg.sender` is the CREATE2 factory, so encode
explicit ownership arguments when the implementation needs them. Add desired
implementation-specific call/storage assertions to the generated proxy resource
before creating a plan; the compiler does not infer them from initializer bytes.

Keep the initial implementation resource, salts, owner and initializer fixed.
Changing only the desired implementation preserves both deterministic addresses
and compiles `upgradeToChecked(address,bytes32)` with the desired address and
runtime hash. The beacon enforces the owner and exact nonempty runtime in the
same transaction; its unguarded `upgradeTo(address)` entrypoint always reverts.
Runtime guards can reject a transaction after submission, so they do not promise
that every stale plan is blocked before signing. A newly missing proxy still
requires the fixed initial implementation to be selected by the beacon; it
cannot silently initialize through an already-upgraded beacon.

The strategy verifies code identity and declared beacon/owner facts. Review
storage-layout compatibility and initializer/migration behavior separately.
It does not support UUPS, transparent proxies, upgrade-and-call migrations,
nonzero deployment value or arbitrary existing beacon implementations. Changes
to this pinned compiler/contract family in a later release may change creation
addresses; retain the reviewed literal manifest for an existing deployment.

This package contains no OAAth dependency. The direct viem provider is an
ordinary EOA execution path and does not emulate OAAth permissions.

`ReviewedPlan` is a JSON-safe, content-addressed artifact that embeds and is
validated against its normalized manifest. Direct viem execution requires an
explicit confirmation count.

`createMoesi({ observer }).verify({ plan })` is the authority-free semantic
boundary. It reparses the exact reviewed plan, captures a fresh pinned snapshot
for each chain, and reports runtime, exact read-only attestation, and managed
configuration convergence without an execution provider, signer, or
DeploymentRun store.

Every manifest contract has an explicit resource kind and exact `checks` and
`storageChecks` arrays. Call checks bind an id, nonzero simulation caller,
calldata, and expected return value. Storage checks bind an id and canonical
32-byte slot to an expected 32-byte word. The pinned `eth_call` and
`eth_getStorageAt` assertions are read-only for both resource kinds: they never
create repair calls, execution steps, requirements, sender claims, or
enforcement authority. A `managed` resource additionally owns its deterministic
deployment and optional repairable configuration. Attestation-only managed
drift is blocked; configuration-only drift is actionable; mixed drift is
partial and contains only the configuration work. An `external` resource pins
an exact address and remains entirely verify-only. Literal checks can express
owner/admin calls or proxy slots. Use `semanticChecks` for the supported typed
expectations; Moesi does not infer upgrades or remediation from either form.

The current `create2-factory-v1` strategy is closed over the canonical
Arachnid deterministic deployment proxy. Manifests provide only salt,
init-code, value, and the required runtime-prerequisite IDs; they cannot
substitute a factory. Planning pins the factory's exact runtime-code capability,
and execution re-attests it on a fresh canonical descendant snapshot before any
deployment submission fence.

The closed `createx-create2-v1` and `createx-create3-v1` strategies pin the
canonical CreateX factory. They accept exactly 11 bytes of entropy and require
an `owner-eoa` or `smart-account` sender with a concrete `address`. Smart accounts
also require their provider's `accountId`. Moesi derives the sender-protected
raw salt as `sender(20) || 0x00 || entropy(11)`. Address prediction, calldata,
configuration-read callers, and provider requirements bind the same address.
CREATE3's address is independent of init code. Arbitrary raw salts, other guard
branches, and custom factories are rejected.
Mixed plans retain separate chain-and-strategy capability evidence, and the
runner re-attests the matching factory immediately before each deploy fence.

`predictManifestAddresses(manifest)` validates a complete manifest and returns
immutable `{ resourceId, address }` entries without RPC. For example, protected
CREATE3 with sender `0xc3a56de6dfc1dcef5113927ec09513918e8c44aa` and entropy
`0x04a9469db98e61f23775c1` predicts `0xafdea3e6716239482c2378a3bf6d24fbdd99b077`.
`deriveCreateXSenderProtectedRawSalt({ sender, entropy })` exposes its raw salt.

`DeploymentRun` persists one versioned record through a caller-owned atomic
store. It checkpoints a possible-submission fence before the provider side
effect, retains opaque references before observation, and resumes submitted
work through observation only. `MemoryDeploymentRunStore` is provided for
tests and single-process applications; durable adapters must implement atomic
create-if-absent and revision compare-and-swap.

A missing configured resource produces one immutable deploy-then-configure
sequence. All same-chain deployments run before configuration.

### Execution packing

`reviewExecution({ plan, provider, packing: "per-chain" })` binds every chain's
exact ordered calls to one atomic provider operation. Providers with
`submitBatch` default to this packing; providers without it default to
`"per-step"`. Explicit per-chain packing on a provider without atomic submission
fails before signing. The direct viem provider uses per-step transactions.

`ReviewedExecution.packing` is immutable. Each provider chain review exposes the
exact sender, `signer` (`owner`, `session`, or `unavailable`) and structured
`signerReason`. `compileExecutionOperations(plan, review.packing)` exposes the
exact operation IDs, chains and ordered steps without changing the plan.
Provider review and prepare receive the same packing choice.

Runs persist `operations`, each with `operationId` and ordered `stepIds`.
Each operation has one possible-submission fence, reference and terminal
evidence. Recovery observes a retained reference; it never resubmits part of a
batch. Finalized evidence must contain all calls in the reviewed order, with
the reviewed values and sender. Partial, duplicated or reordered calls fail
verification. An operation is skipped only when every call is configuration
whose postconditions already hold; individual calls are never removed from an
accepted batch.

Before each operation, Moesi checks peer lineage, factory capabilities and
existing runtime prerequisites at fresh canonical pins. A resource deployed
earlier within the same atomic operation is verified after execution, together
with every deployment and configuration postcondition. Atomic packing has no
intermediate RPC checkpoint between calls. Use per-step packing when that
checkpoint is required. Provider finality and successful call evidence do not
prove deployment convergence.

Managed deployments require an explicit `requiresRuntime` array. Each entry is
an exact manifest resource ID. Unknown IDs, self-reference, duplicates and
cycles are rejected; missing managed prerequisites are planned in deterministic
dependency order. Existing prerequisites must match their reviewed runtime
hashes before submission. For prerequisites created earlier in an atomic
operation, runtime verification is deferred to convergence. Semantic storage,
call or configuration drift does not change the runtime prerequisite check.

The current execution-review, deployment-run and run-result schemas are v3, v9
and v6 respectively. Recreate old artifacts; no in-place upgrade is provided.

### Configuration batches and peer readiness

Configuration rows may declare `batch: { key, parameters, maxRows }`. Rows in a
batch must be adjacent, use the same write selector, have zero value, and encode
exactly one item in each primitive or tuple ABI array (for example `uint256[]` and
`address[]`). Planning merges only drifted, ready rows, in declaration order,
and splits at `maxRows` (1–256). Every row keeps its own read and postcondition.
A missing contract schedules all ready rows after deployment. Deployment steps
have `configurationIds: []`; a configuration step lists every row it writes.

A row may also declare `after: [{ chainId, address, expectedRuntimeCodeHash }]`.
Moesi observes each distinct peer at an exact block pin. A missing peer produces
`pending-peer` readiness; an unreadable or changed runtime produces
`blocked-peer`. Neither permits the row's write. Plans retain immutable `peers`
evidence, and an entirely pending plan has disposition `pending`. Replan when
the peer is deployed to produce a new executable plan. Execution rechecks peer
runtime and block lineage before submission; verification also checks peers.
These are observations on separate chains, not a cross-chain atomicity guarantee.

### Typed fleet authoring

`defineFleet` from `moesi/fleet` compiles typed per-chain resources and configuration
callbacks to immutable `{ manifest, chains, reads }[]`. Use `ctx.contract(id).rule`
for ABI-typed reads, expected results and writes; `ctx.address(id)` and
`ctx.account(name)` resolve public identity references. `ctx.deployedOn` produces
literal peer prerequisites. Optional `ctx.read` bakes pinned cross-chain return
values into literals and retains safe read provenance. Identical manifests group
together with at most 32 chains per plan; pass each group to `moesi.plan(group)`.

See the [0.9 migration guide](https://github.com/leekt/moesi/blob/main/docs/migration-0.9.md)
for a worked route matrix, constructor references, fee tuples, and peer behavior.

`checkFleetParity({ ...group, baseline, observer })` compares an independent
`moesi.fleet-baseline/v1` export of the existing application's resolved
declarations with the candidate manifest at shared live block pins. Use
`parseFleetBaseline` to validate an export before comparison. The report retains
both addresses, declared reads, expected and observed values, peer readiness,
candidate plan disposition and structured differences. `match` means parity,
even if both versions observe the same drift; convergence still needs separate
verification. Unreadable evidence never becomes a successful comparison.
The [migration guide](https://github.com/leekt/moesi/blob/main/docs/migration-0.9.md#compare-with-the-existing-live-fleet)
describes exporting the baseline and running `moesi check-parity` without a signer.

### Compiler artifacts

`prepareSolidityArtifact({ artifact, constructorArgs, libraries })` captures a full
Foundry, solc contract-output or Hardhat 3 artifact. Its `initCode` and
`initCodeHash` include the exact constructor arguments and linked libraries.
`prepared.compile()` returns literal `initCode`, `expectedRuntimeCodeHash` and
versioned compiler provenance for static runtime code.

When `requiresRuntimeEvaluation` is true, call
`prepared.compile({ initCodeHash: prepared.initCodeHash, code })` with expected
runtime evaluated in the intended deployment context. It verifies immutable
locations and every unchanged byte; it does not prove the evaluator's caller,
creation address, chain state or constructor reads. Missing or inconsistent
evidence fails with `MoesiArtifactError.code` and `.path`. See the
[artifact workflow](https://github.com/leekt/moesi/blob/main/docs/artifacts.md)
for linking, runtime evaluation and standalone exports.

## Read-only chain utilities

`batchCheckCode`, `batchOpcodeProbes`, and `runFeatureProbe` use a caller-owned
viem public client. They are diagnostic utilities, separate from the pinned
deployment evidence in a `ReviewedPlan`. Pass an explicit block number when
comparing multiple reads; an omitted pin uses the client's latest state.

```ts
import { batchCheckCode, runFeatureProbe } from "moesi";

const codes = await batchCheckCode(publicClient, addresses, {
  blockNumber,
  fallback: "getCode",
});
const hasCode = codes.results[address.toLowerCase()];
// true = code present; false = empty; undefined = unreadable.

const outcome = await runFeatureProbe(publicClient, "push0", blockNumber);
if (outcome.supported === null) {
  // Handle outcome.error; no support decision is available.
}
```

Code checks accept at most 1,024 address entries, deduplicate them, and normally
use one state-override call. The default per-address fallback omits unreadable
addresses from `results`; `count` counts requested unique addresses, including
unreadable ones. Choose `fallback: "none"` to require the batch path.

Opcode batches accept at most 255 unique ASCII IDs and 1–31-byte payloads, with
an optional third block-number argument. The simulation requires state override
but no factory deployment or signer. Each payload receives 100,000 gas; a false
result means execution failed within that budget. RPC and malformed-response
failures throw a scrubbed `MoesiProbeError`, never an unsupported-opcode result.

Feature outcomes distinguish supported, unsupported, and inconclusive evidence.
Use `supported === true`, not truthiness of the result object. PREVRANDAO remains
inconclusive when its sampled value cannot distinguish it from difficulty.
EIP-7702 always reports `inconclusive`: code-override simulation cannot establish
authorization-transaction activation. Contract-presence features only check for
code at known addresses; they do not attest the contract's identity. Catalogs
and probe results are immutable.

Nick's-method helpers build chain-neutral legacy transactions with `v` of 27 or
28. Parameters must be an exact record with nonempty init code, positive gas
limit, unsigned quantities, a nonzero `r` below the curve order, and nonzero
low-`s`. Recovery failures expose only a structured `MoesiManifestError`;
constructing a transaction does not prove a chain will accept or deploy it.
