# Moesi

Moesi is onchain Terraform: it observes pinned chain state, detects drift,
creates a deterministic reviewed deployment plan, executes that plan through
OGP, and independently verifies semantic convergence.

This repository is an early pre-release rebuild. It currently implements the
single current manifest contract, pinned bytecode and static-call observation,
deterministic CREATE2 and configuration-remediation planning, immutable reviewed
plans, and an in-memory deployment Run that re-verifies runtime bytecode and
configuration after execution. Direct OGP integration, durable Run restoration,
and CLI apply are not yet release-ready. The deployment-focused `moesi plan`
command is available from the private pre-release `@moesi/cli` package.

```ts
import { createMoesi } from "moesi";

const moesi = createMoesi({ observer });
const plan = await moesi.plan({
  chains: [8453],
  manifest: {
    version: "moesi.manifest/v1",
    contracts: [
      {
        id: "counter",
        deployment: {
          kind: "create2-factory-v1",
          factory,
          salt,
          initCode,
          value: "0",
        },
        expectedRuntimeCodeHash,
        configuration: [
          {
            id: "value",
            readData,
            expectedResult,
            writeData,
            value: "0",
          },
        ],
      },
    ],
  },
});
```

`create2-factory-v1` means the factory call is exactly
`deploy(bytes32 salt, bytes initCode) payable returns (address)`, and the
expected address uses ordinary CREATE2 derivation from that factory, salt, and
init-code hash. The configured factory must implement those reviewed semantics.

Each configuration rule is one exact static call and one exact remediation call
to the derived contract address. Rules are deliberately calldata-first: Moesi
does not own a generic ABI or provider framework. Missing code produces only a
deployment step; the Run checks configuration after deployment, and a following
plan compiles any required configuration calls. This makes multi-pass
convergence explicit.

The observation adapter captures a block number/hash pair and receives that
same pair with every code or static-call read. Provider failures and malformed
responses become structured `unreadable` cells; they are never treated as
absence or drift.

`createDeploymentRun` accepts a narrow execution capability until the released
OGP client is available. The capability receives one frozen reviewed call batch
per chain and must resolve only after OGP has verified that exact batch finalized
successfully:

```ts
import { createDeploymentRun } from "moesi";

const run = createDeploymentRun({
  plan,
  observer,
  async execute(batch) {
    const finalized = await executeAndFinalizeThroughOGP(batch);
    return {
      chainId: batch.chainId,
      operationId: finalized.identity.userOperationHash,
    };
  },
});

const result = await run.wait();
```

`wait()` invokes execution at most once, batches multiple calls on the same
chain into one operation, and permits distinct chains to proceed independently.
Moesi then captures fresh pinned snapshots and verifies deployment bytecode and
every reviewed configuration call.
Finalized OGP evidence and Moesi convergence evidence remain separate in the
result. This in-memory Run makes no process-crash or durable-resume claim.

## CLI

The CLI reads the same `moesi.manifest/v1` JSON contract used by the library:

```sh
moesi plan \
  --manifest ./moesi.json \
  --chain 8453=https://rpc.example \
  --json
```

Each chain binding is explicit. Observation captures `latest` once and reads
code and configuration using that block hash with `requireCanonical: true`;
there is no retry or block-number fallback. Exit codes are 0 for converged, 2
for changes, 3 for a blocked or partial plan, and 1 for command or snapshot
failures.

All releases remain `0.x.y`. Before 1.0, obsolete contracts are removed rather
than supported through compatibility layers.

## Verification

`pnpm check` runs the offline-default lint, build, typecheck, and unit-test
gate. `pnpm test:anvil` is an explicit local integration proof that requires
`solc` and `anvil` on `PATH`; it compiles repository fixtures, starts a temporary
loopback chain, and verifies deploy → configuration drift → remediation →
convergence without contacting a shared RPC.
