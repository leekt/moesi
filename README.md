# Moesi

Moesi is provider-neutral onchain Terraform: it observes pinned chain state,
detects drift, creates a deterministic reviewed deployment plan, executes it
through one explicitly selected provider, and independently verifies semantic
convergence.

This repository is an early pre-release rebuild. The current slice includes:

- one current `moesi.manifest/v1` with managed and exact-address external
  contract resources;
- pinned bytecode and static-call observation;
- deterministic CREATE2 deployment and configuration-remediation planning;
- immutable, content-addressed `ReviewedPlan` artifacts;
- provider-neutral sender and enforcement requirements;
- explicit provider review bound to the exact plan;
- a built-in direct viem provider at `moesi/viem`;
- a versioned durable DeploymentRun with provider references, safe resume, and
  fresh convergence checks;
- CLI plan, offline inspect, authority-free verify, explicit direct-viem
  review/apply/resume, and offline Run status.

Moesi core has no `@oaath/*` dependency or implementation.

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
const verification = await moesi.verify({ plan });
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
weak but permitted. That policy is bound into both the provider review route
and each durable transaction reference, so a recreated process cannot silently
weaken finality.

## Manifest Semantics

Every contract has an explicit `kind`. A managed resource owns deployment and
optional configuration work:

```json
{
  "kind": "managed",
  "id": "counter",
  "deployment": {
    "kind": "create2-factory-v1",
    "salt": "0x...",
    "initCode": "0x...",
    "value": "0"
  },
  "expectedRuntimeCodeHash": "0x...",
  "configuration": []
}
```

An external resource pins an already-known address for observation and
verification only:

```json
{
  "kind": "external",
  "id": "canonical-registry",
  "address": "0x...",
  "expectedRuntimeCodeHash": "0x...",
  "checks": [
    {
      "id": "live",
      "caller": "0x...",
      "readData": "0x...",
      "expectedResult": "0x..."
    }
  ]
}
```

External checks are exact read-only assertions. Their nonzero `caller` is the
simulation identity supplied as `from`; `readData` is sent to the external
resource's exact address at the same pinned EIP-1898 block hash as its runtime
read. A missing, bytecode-drifted, unreadable, or check-drifted external
resource is blocked. External resources have no deployment, repairable
configuration, sender, enforcement, or execution authority, so checks produce
no factory capabilities, steps, or execution requirements. Independent managed
changes remain reviewed work and make the overall plan partial. Moesi never
turns external check drift into a transaction.

`create2-factory-v1` is closed over the canonical Arachnid deterministic
deployment proxy at `0x4e59b44847b379578588920ca78fbf26c0b4956c`.
Its exact calldata is `salt || initCode`, and the expected address is derived
from that fixed factory, salt, and init-code hash. The manifest cannot select a
different factory.

When a chain has missing resources, planning records one pinned factory
capability with the expected runtime-code hash. Missing deployment and
configuration actions are emitted only when that exact capability is
available; an absent, unreadable, or bytecode-drifted factory blocks those
actions on that chain.

Each configuration rule is one exact static call and one exact remediation
call. Missing code produces one fixed reviewed sequence containing the
deployment and every declared configuration action. On each chain, all
deployments precede all configuration actions. Each `writeData` value is the
manifest author's exact reviewed post-deployment convergence action; execution
never rebuilds or substitutes it after review.

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
snapshot and verifies runtime bytecode, managed configuration, and external
read-only checks.
The fresh snapshot must also descend from the reviewed planning snapshot and
every retained execution inclusion block. Block lineage is checked by hash;
matching or increasing block numbers alone are never sufficient.

Before a post-deployment configuration action can cross its durable submission
fence, Moesi captures another pinned snapshot, proves it descends from the plan
and every finalized same-chain action, and rechecks the exact runtime hash of
the target plus every resource deployed earlier in the plan. Unreadable,
reorged, missing, or mismatched runtime evidence leaves the configuration step
pending and submits nothing.

Before a deployment can cross its durable submission fence, Moesi likewise
captures a fresh descendant snapshot and re-attests the canonical factory's
exact runtime hash. Unreadable, reorged, missing, or mismatched capability
evidence leaves the deployment pending and submits nothing.

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

# Assume MOESI_DEPLOYER_KEY is supplied by your secret manager.

# First invocation: review only. It prints a review ID and sends nothing.
moesi apply \
  --plan ./plan.json \
  --provider viem \
  --chain 8453=https://rpc.example \
  --signer 8453=MOESI_DEPLOYER_KEY \
  --confirmations 2 \
  --store ./.moesi/runs \
  --json

# Second invocation: accept the exact plan/provider/store decision.
moesi apply \
  --plan ./plan.json \
  --provider viem \
  --chain 8453=https://rpc.example \
  --signer 8453=MOESI_DEPLOYER_KEY \
  --confirmations 2 \
  --store ./.moesi/runs \
  --accept-review 0x... \
  --json

moesi resume \
  --run 0x... \
  --provider viem \
  --chain 8453=https://rpc.example \
  --confirmations 2 \
  --store ./.moesi/runs \
  --json

moesi inspect --plan ./plan.json
moesi verify --plan ./plan.json --chain 8453=https://rpc.example --json
moesi status --run 0x... --store ./.moesi/runs --json
```

Planning exits 0 for converged, 2 for changes, and 3 for blocked or partial
state. Verification exits 0 for converged, 2 for drifted, and 3 for unreadable.
Inspection exits 0 for every valid plan disposition. Invalid input and planning
snapshot failures exit 1.
Each CLI RPC binding is checked with `eth_chainId` before observation; a URL on
the wrong chain cannot produce a mislabeled plan.

`verify` accepts only the saved reviewed plan and exact chain bindings. It
captures fresh pinned snapshots and checks runtime bytecode, managed
configuration, and external read-only assertions without a provider, signer,
Run store, or transaction submission. Its result
is the versioned `moesi.verification-result/v1` artifact; status precedence is
unreadable, then drifted, then converged. Human plan, inspect, verify, and
first-pass apply-review output identify each resource as `managed` or
`external`; external resources are labeled verify-only with no execution
authority. Human inspection labels external declarations and reviewed evidence
as `manifest-external-check`, `external-check`,
`external-check-observation`, or `external-check-mismatch`; execution reviews
retain each exact caller, calldata, expected result, and observed blocker before
showing an approval command.

`inspect` reads the saved `moesi.cli-plan/v1` artifact offline. Human output
expands its normalized manifest, pinned snapshots and factory capabilities,
runtime, configuration, and external check evidence, ordered exact calls,
sender and enforcement requirements, and postconditions. JSON canonically
re-emits the same artifact;
inspection creates no second plan schema and uses no runtime authority.

`plan --json` emits a versioned wrapper whose `plan` is the exact JSON-safe
`ReviewedPlan`. The plan embeds its normalized manifest, uses canonical decimal
strings for block numbers and call values, and round-trips through
`parseReviewedPlan(JSON.parse(source))` without a bigint reviver.

`status` is offline and reads the latest contiguous, validated Run revision
from the local append-only store. It never creates a missing store directory
and never infers semantic convergence from execution evidence.

Execution has no implicit provider. `--provider viem` is required, and
`--signer` accepts a chain-to-environment-variable binding rather than a key on
the command line. The first `apply` invocation is review-only: it creates no
Run and submits nothing. The accepted review digest binds the exact plan,
provider decision, confirmation policy, sender, and resolved store identity.

`resume` observes retained submitted references without a signer and without a
second send. If untouched pending work remains reachable, it requires signers
for the original reviewed requirements before continuing. A first SIGINT or
SIGTERM requests a durable-safe stop between effects; signal handlers are then
removed so a second signal retains the platform's hard-stop behavior.

## Verification

`pnpm check` runs the offline-default lint, build, typecheck, and unit suites.
`pnpm smoke:packed` exercises both public tarballs from clean consumers, and
`pnpm audit:prod` checks only the shipped dependency graph. Workspace builds
use Node `^22.18.0 || >=24.11.0`, matching the pinned build tool; the public
packages retain and are exercised at their declared Node `>=22.13` runtime
floor.

`pnpm test:anvil` compiles local fixtures with `solc-js`, starts temporary Anvil,
and proves deployment, provider review, transaction observation, configuration
remediation, process-recreated CLI resume, and keyless fresh verification of
convergence and drift without contacting a shared RPC.

All releases remain `0.x.y`. Before 1.0, obsolete contracts are removed rather
than supported through compatibility layers.
