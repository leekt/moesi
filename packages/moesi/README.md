# moesi

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
`moesi.manifest/v4`; text parsing does not introduce another persisted format.

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

Current manifest, reviewed-plan, and deployment-run schemas are v4; stale
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

The closed `createx-create2-v1` strategy similarly pins the canonical CreateX
factory. It accepts exactly 11 bytes of entropy and requires an `owner-eoa`
sender; Moesi derives the sender-protected raw salt as
`sender(20) || 0x00 || entropy(11)`. The resulting address, calldata, and
provider requirement therefore name the same submitting EOA. No raw-salt
escape hatch, alternate guard, CREATE3 branch, or custom factory is accepted.
Mixed plans retain separate chain-and-strategy capability evidence, and the
runner re-attests the matching factory immediately before each deploy fence.

`DeploymentRun` persists one versioned record through a caller-owned atomic
store. It checkpoints a possible-submission fence before the provider side
effect, retains opaque references before observation, and resumes submitted
work through observation only. `MemoryDeploymentRunStore` is provided for
tests and single-process applications; durable adapters must implement atomic
create-if-absent and revision compare-and-swap.

A missing configured resource produces one immutable deploy-then-configure
sequence. All same-chain deployments run before configuration. Before any
post-deployment configuration can cross its submission fence, Moesi captures a
fresh canonical descendant snapshot and rechecks the exact runtime hashes of
the target and every resource deployed earlier in the plan. Uncertain or
mismatched evidence leaves that configuration pending and submits nothing.

Managed deployments require an explicit `requiresRuntime` array. Each entry is
an exact manifest resource ID whose same-chain runtime must match the reviewed
hash before the dependent deployment. Unknown IDs, self-reference, duplicates,
and cycles are rejected; reachable missing managed prerequisites are planned in
deterministic dependency order. This is not a full-convergence dependency:
semantic storage, call, or configuration drift after an exact runtime still
satisfies it. Missing, wrong-code, or runtime-unreadable prerequisites block the
dependent. A fresh canonical descendant snapshot rechecks every direct target
before the deployment submission fence, so resume can safely retry after repair.
