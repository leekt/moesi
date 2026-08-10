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
for each chain, and reports runtime, managed-configuration, and external-check
convergence without an execution provider, signer, or DeploymentRun store.

Every manifest contract has an explicit resource kind. A `managed` resource
owns its deterministic deployment and optional configuration actions. An
`external` resource declares its id, exact address, expected runtime-code hash,
and explicit `checks` and `storageChecks` arrays. Call checks bind an id,
nonzero simulation caller, calldata, and expected return value. Storage checks
bind an id and canonical 32-byte slot to an expected 32-byte word. The pinned
`eth_call` and `eth_getStorageAt` assertions are verify-only: missing or drifted
code and mismatched or unreadable checks block the external cell but create no
factory capability, repair call, execution step, requirement, sender, or
enforcement authority. Independent executable managed drift remains reviewed
in a partial plan.

The current `create2-factory-v1` strategy is closed over the canonical
Arachnid deterministic deployment proxy. Manifests provide only salt,
init-code, and value; they cannot substitute a factory. Planning pins the
factory's exact runtime-code capability, and execution re-attests it on a fresh
canonical descendant snapshot before any deployment submission fence.

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
