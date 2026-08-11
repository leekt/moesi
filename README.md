# Moesi

Moesi is provider-neutral onchain Terraform: it observes pinned chain state,
detects drift, creates a deterministic reviewed deployment plan, executes it
through one explicitly selected provider, and independently verifies semantic
convergence.

This repository is an early pre-release rebuild. The current slice includes:

- one current `moesi.manifest/v1` contract;
- pinned bytecode and static-call observation;
- deterministic CREATE2 deployment and configuration-remediation planning;
- immutable, content-addressed `ReviewedPlan` artifacts;
- provider-neutral sender and enforcement requirements;
- explicit provider review bound to the exact plan;
- a built-in direct viem provider at `moesi/viem`;
- a versioned durable DeploymentRun with provider references, safe resume, and
  fresh convergence checks;
- a read-only `moesi plan` CLI command.

CLI apply/status and the optional `@moesi/oaath` adapter are separate follow-up
slices. Moesi core has no `@oaath/*` dependency.

## Direct Viem

```ts
import { createMoesi, MemoryDeploymentRunStore } from "moesi";
import {
  createViemExecutionProvider,
  createViemObservationAdapter,
} from "moesi/viem";

const publicClientForChain = (chainId: number) => publicClients.get(chainId);
const walletClientForChain = (chainId: number) => walletClients.get(chainId);

const moesi = createMoesi({
  observer: createViemObservationAdapter({ publicClientForChain }),
  runStore: new MemoryDeploymentRunStore(),
});

const plan = await moesi.plan({ manifest, chains: [8453] });
const provider = createViemExecutionProvider({
  publicClientForChain,
  walletClientForChain,
  confirmations: 1,
});
const executionReview = await moesi.reviewExecution({ plan, provider });

if (executionReview.provider.status === "blocked") {
  throw new Error("Selected provider cannot satisfy this plan");
}

const result = await moesi
  .apply({ plan, provider, executionReview })
  .wait();
```

`reviewExecution` submits and signs nothing. It exposes each chain's actual
sender, resolved logical account identity, route, enforcement level, and
structured block reasons. The accepted review is bound to `plan.planId`;
changing the plan or provider requires a new review.

The viem provider submits one ordinary EOA transaction per reviewed action. It
blocks before signing when a plan requires a smart-account sender, a different
EOA, or enforcement it cannot provide. Observation is read-only, validates the
transaction against a canonical confirmed receipt, and never resubmits.
`confirmations` is required so the caller explicitly chooses the provider's
terminal receipt policy for the selected chains; a value of 1 is intentionally
weak but permitted.

## Manifest Semantics

`create2-factory-v1` calls exactly
`deploy(bytes32 salt, bytes initCode) payable returns (address)`. The expected
address is derived from the factory, salt, and init-code hash.

Each configuration rule is one exact static call and one exact remediation
call. Missing code produces only a deployment step; a following plan compiles
configuration remediation after the deployment exists. Multi-pass convergence
is explicit.

Every static-call witness records a caller. An `owner-eoa` declaration uses
that exact address. Sender-independent and logical smart-account resources use
the zero address as their deterministic planning witness, so their
configuration reads must not depend on `msg.sender`, `tx.origin`, an executor,
or the submission route. A logical-account address needed by a read must be
bound in a future manifest before planning; provider review cannot rewrite a
reviewed postcondition.

A contract may declare an execution sender:

```json
{
  "sender": {
    "kind": "owner-eoa",
    "address": "0x..."
  }
}
```

`smart-account` sender declarations are provider-neutral and make the direct
viem provider block. Absence means sender-independent; manifest authors must
not omit a sender when ownership, factory access, funding, or postconditions
depend on it.

Contracts may also require call-scope, expiry, and operation-limit enforcement.
The direct viem provider exposes interactive call review but no expiry or
operation-count enforcement, and blocks requirements it cannot satisfy.

## Evidence

Observation captures a block number/hash pair and pins every code or static-call
read to that exact canonical block. Failures and malformed responses become
structured `unreadable` cells; they are never absence or drift.

Provider finality and Moesi convergence are separate evidence boundaries. A
durable `submission-requested` fence is committed before every possible wallet
submission, and a returned provider reference is committed before observation.
Resume observes retained references without submitting them; a fence with no
reference stays ambiguous. After provider execution, Moesi captures a fresh
snapshot and verifies runtime bytecode and configuration.
The fresh snapshot must also descend from the reviewed planning snapshot and
every retained execution inclusion block. Block lineage is checked by hash;
matching or increasing block numbers alone are never sufficient.

Before provider preparation or submission, apply first proves that every
reviewed planning snapshot is still on the current chain. The built-in viem
adapter bounds a lineage walk to 4,096 blocks; an older plan is rejected before
signing and must be recreated.

## CLI

```sh
moesi plan \
  --manifest ./moesi.json \
  --chain 8453=https://rpc.example \
  --json
```

Exit codes are 0 for converged, 2 for changes, 3 for blocked or partial state,
and 1 for invalid input or failed snapshot capture.
Each CLI RPC binding is checked with `eth_chainId` before observation; a URL on
the wrong chain cannot produce a mislabeled plan.

`--json` emits a versioned wrapper whose `plan` is the exact JSON-safe
`ReviewedPlan`. The plan embeds its normalized manifest, uses canonical decimal
strings for block numbers and call values, and round-trips through
`parseReviewedPlan(JSON.parse(source))` without a bigint reviver.

## Verification

`pnpm check` runs the offline-default lint, build, typecheck, and unit suites.
`pnpm test:anvil` compiles local fixtures with `solc-js`, starts temporary Anvil,
and proves deployment, provider review, transaction observation, configuration
remediation, and convergence without contacting a shared RPC.

All releases remain `0.x.y`. Before 1.0, obsolete contracts are removed rather
than supported through compatibility layers.
