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
