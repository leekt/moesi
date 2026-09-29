# moesi

Provider-neutral onchain Terraform core. Public APIs are documented in the
repository [README](https://github.com/leekt/moesi#readme).

```ts
import { createMoesi } from "moesi";
import { createViemExecutionProvider } from "moesi/viem";
```

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
owner/admin calls or proxy slots, but Moesi does not infer ownership, proxy
kind, roles, upgrades, or remediation from them.

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
provider requirement therefore name the same submitting EOA. The separate
`createx-create2-unguarded-v1` and `createx-create3-unguarded-v1` strategies derive
an unguarded zero-prefixed salt from the same 11-byte entropy. The CREATE3
address is independent of init code. No arbitrary raw-salt input, alternate
guard, or custom factory is accepted.
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

## Lifecycle and recovery

Parse a manifest with `parseManifest`, observe with `createMoesi().plan`, and
persist the JSON-safe `ReviewedPlan` if another process will inspect or verify it.
Use `parseReviewedPlan(JSON.parse(source))` at that file boundary; do not edit
reviewed calls after planning. The CLI wraps this artifact in `moesi.cli-plan/v1`.

`reviewExecution({ plan, provider })` creates an immutable decision bound to the
exact plan and provider instance. Inspect it before calling `apply`. A blocked
review cannot execute. Changed calls or provider settings require a new review.
`apply` returns a lazy `DeploymentRun`; execution begins with `run.wait()`.
Keep `run.runId` and your durable store for recovery. Repeated waits on the same
run share the operation. Use `run.requestStop()` for a cooperative stop.

For recovery, recreate the client with the same durable store and use
`await client.resume({ runId, provider })`, then `await run.wait()`. Retained
references are observed without resubmission. Reachable pending actions require
an exact provider preflight and may submit; a submission fence without a
reference remains ambiguous. Do not delete stored progress to force a retry.
A converged run includes fresh deployment verification. A finalized transaction
alone does not prove convergence.

`verify({ plan })` can check old saved plans without a signer or store. Its reads
are pinned to fresh canonical snapshots at least as high as the plan snapshots;
it does not walk ancestry back to an old plan. Apply and resume additionally
prove lineage from planning and retained execution blocks. Treat `unreadable`
as missing evidence, not as drift or success.

`MemoryDeploymentRunStore` cannot survive process exit. Applications that submit
transactions across sessions must supply a durable atomic store. The CLI includes
its own file store through `--store`.

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
