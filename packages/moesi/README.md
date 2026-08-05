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
