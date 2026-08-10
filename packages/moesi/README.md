# moesi

Provider-neutral onchain Terraform core. Public APIs are documented in the
repository [README](../../README.md).

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
