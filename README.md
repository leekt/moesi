# Moesi

Moesi is provider-neutral onchain Terraform: it observes pinned chain state,
detects drift, creates a deterministic reviewed deployment plan, executes it
through one explicitly selected provider, and independently verifies semantic
convergence.

This repository is an early pre-release rebuild. The current slice includes:

- one current `moesi.manifest/v6` with managed and exact-address external
  contract resources;
- pinned bytecode, static-call, and storage-word observation;
- explicit owner, role and ERC-1967 expectations in drift and verification;
- read-only [contract discovery](packages/moesi/README.md) with explicit
  ERC-1967 slot, owner, and role probes at rechecked pinned blocks;
- deterministic CREATE2 deployment and configuration-remediation planning;
- immutable, content-addressed `ReviewedPlan` artifacts;
- provider-neutral sender and enforcement requirements;
- explicit provider review bound to the exact plan;
- a built-in direct viem provider at `moesi/viem`;
- an optional OAAth execution provider at `@moesi/oaath`;
- a versioned durable DeploymentRun with provider references, safe resume, and
  fresh convergence checks;
- CLI plan, offline inspect, authority-free verify, explicit direct-viem
  review/apply/resume, and offline Run status.

Moesi core has no `@oaath/*` dependency or implementation.

## Start from this checkout

Build this checkout with Bun 1.4.2, then run the Node-compatible CLI:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
node ./packages/cli/dist/bin.js --help
```

Start with [the complete minimal manifest](examples/minimal.manifest.json).
It deploys a two-byte demonstration runtime (`0x6000`) through the canonical
CREATE2 factory. Use your own compiled init code, expected runtime hash, checks,
and sender requirements for real resources. From this checkout, replace
`moesi` in the commands below with `node ./packages/cli/dist/bin.js`.

The CLI workflow is **plan → inspect → review → apply → verify**. Use **status**
and **resume** to recover interrupted work. Every command accepts `--help`.

## Runnable examples

`bun run examples:local` runs the [four public-package examples](examples/README.md)
against owned local chains: direct viem, OAAth, one-Grant multichain OAAth and
configuration drift repair. No live RPC credentials are needed.

## Direct Viem

For URL-only fleet reads, use [`createViemObserver`](packages/moesi/README.md#reading-a-fleet-through-rpc-url-pools).
It provides failover, full-request timeouts, bounded concurrency, JSON-RPC
batching, fresh per-chain pins, cancellation, and safe diagnostic causes.
Use the adapter below when you already own your viem clients and transport policy.

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

## Execution Provider Seam

`MoesiExecutionProvider`, `ProviderExecutionReference`, and
`ProviderExecutionEvidence` are the public seam for alternative execution
paths. They describe the current reviewed provider contract. Before 1.0, APIs
and persisted artifacts may change; breaking changes are documented in release
notes and obsolete formats are rejected.

The optional [`@moesi/oaath`](packages/oaath-adapter/README.md) provider executes
smart-account plans through the public OAAth SDK. The caller owns the SDK
instance and its persisted realm. Consent is explicit before read-only review:

```ts
import {
  createOAAthExecutionProvider,
  requestOAAthPlanPermission,
} from "@moesi/oaath";

// `oaath` is the application's configured public OAAth SDK instance.
await requestOAAthPlanPermission({ oaath, plans: [plan] });
const provider = createOAAthExecutionProvider({ oaath });
const executionReview = await moesi.reviewExecution({ plan, provider });
if (executionReview.provider.status === "blocked") {
  throw new Error("Selected provider cannot satisfy this plan");
}
const result = await moesi.apply({ plan, provider, executionReview }).wait();
```

The adapter compiles one all-chain permission request, reuses covered authority,
and exposes the SDK's actual session signer, route and onchain enforcement.
Changed authority invalidates the accepted review. Recovery observes retained
SDK operation IDs; Moesi independently verifies their exact calls and deployment
postconditions. The [CLI](packages/cli/README.md#oaath-execution) supports explicit OAAth selection
with a caller-owned SDK module and a separate `authorize` command.

Development uses the exact OAAth artifacts in [`vendor/oaath`](vendor/oaath/README.md),
with commit provenance and checksums. They are the published `@oaath/*@0.3.0` release.
`bun run smoke:packed:oaath` proves two local chains, one Grant, SDK/store handle
recreation and CLI recovery after OS-process loss. The producer retains a Run
reference before SDK observation, then is killed. A new packed CLI process
reopens the upstream fixture's durable stores, observes the same operation with
no signing or submission capability, and independently verifies convergence.
Anvil remains alive; the parent cleans up its processes and temporary stores.
This proves the fixture's direct-Grant path, not general wallet/key persistence.

## Manifest Semantics

Every contract has an explicit `kind`. A managed resource owns deployment and
optional configuration work:

```json
{
  "kind": "managed",
  "id": "counter",
  "deployment": {
    "kind": "create2-factory-v1",
    "requiresRuntime": [],
    "salt": "0x...",
    "initCode": "0x...",
    "value": "0"
  },
  "expectedRuntimeCodeHash": "0x...",
  "checks": [],
  "storageChecks": [],
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
  ],
  "storageChecks": [
    {
      "id": "admin-slot",
      "slot": "0x...32-bytes...",
      "expectedWord": "0x...32-bytes..."
    }
  ]
}
```

Call and storage checks are exact read-only assertions available to both
managed and external resources. A call check's
nonzero `caller` is the simulation identity supplied as `from`; `readData` is
sent to the resource's exact address at the same pinned EIP-1898 block hash as
its runtime read. A storage check binds one canonical 32-byte slot to
one expected 32-byte word and uses `eth_getStorageAt(address, slot, {
blockHash, requireCanonical: true })`. These attestations never create repair
calls, steps, requirements, sender claims, or execution authority. Managed
resources may separately declare repairable `configuration`; attestation-only
drift is blocked, configuration-only drift is actionable, and a mixture is a
partial plan containing only the exact configuration work. External resources
have no deployment or repairable configuration, so their drift remains
verify-only. Exact checks can express literal owner/admin calls or proxy slots,
while explicit `semanticChecks` provide typed owner, role, and ERC-1967
expectations. Neither form infers upgrades or remediation.

Every managed deployment declares `requiresRuntime`, an exact array of manifest
resource IDs whose same-chain runtime code must match its reviewed hash before
the dependent deploys. Unknown IDs, self-reference, duplicates, and cycles are
rejected; missing managed prerequisites are planned first in deterministic
dependency order. The edge is deliberately runtime-only: later storage, call,
or configuration drift does not turn into a deployment dependency. A missing,
wrong-code, or runtime-unreadable prerequisite blocks the dependent without
creating a call.

`create2-factory-v1` is closed over the canonical Arachnid deterministic
deployment proxy at `0x4e59b44847b379578588920ca78fbf26c0b4956c`.
Its exact calldata is `salt || initCode`, and the expected address is derived
from that fixed factory, salt, and init-code hash. The manifest cannot select a
different factory.

`createx-create2-v1` and `createx-create3-v1` use the canonical CreateX
factory at `0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed`. They accept one exact
11-byte `entropy` and require an explicit `owner-eoa` or `smart-account`
sender with its concrete `address`. The raw salt is
`sender(20) || 0x00 || entropy(11)`. The predicted address, reviewed call, and
execution provider must agree on that sender. CREATE3 deploys through CreateX's
fixed proxy, making its address independent of `initCode`.

Use `predictManifestAddresses(manifest)` for validated offline address
prediction, including resource references. It returns immutable
`{ resourceId, address }` entries. `deriveCreateXSenderProtectedRawSalt` exposes
the exact salt for integrations that need to inspect the reviewed calldata.

`createx-create2-unguarded-v1` and `createx-create3-unguarded-v1` are the
unguarded CreateX strategies. Their raw salt is
`zero-address(20) || 0x00 || entropy(11)`, which CreateX hashes as
`keccak256(abi.encode(rawSalt))` for every sender, so no sender is required
or bound: anyone may submit the reviewed `deployCreate2`/`deployCreate3`
call and the runtime-code-hash postcondition at the derived address carries
convergence. The CREATE3 variant deploys through CreateX's fixed proxy, so
its address is independent of `initCode`. Only this exact zero-prefixed,
`0x00`-flagged raw-salt shape is accepted: it is the one unguarded shape the
CreateX contract itself accepts and that derives identically for every
possible submitter. Other CreateX guards, raw-salt inputs, and custom
factories are not part of this manifest version.

When a chain has missing resources, planning records one pinned capability for
each deployment strategy those resources use. Missing deployment and
configuration actions are emitted only when the matching factory's exact
runtime code is available; absent, unreadable, or bytecode-drifted capability
evidence blocks direct deployments using that strategy and any resources that
declare them as runtime prerequisites.

Each configuration rule is one exact static call and one exact remediation
call. Missing code produces one fixed reviewed sequence containing the
deployment and every declared configuration action. On each chain, all
deployments precede all configuration actions. Each `writeData` value is the
manifest author's exact reviewed post-deployment convergence action; execution
never rebuilds or substitutes it after review.

Every static-call witness records a caller. An `owner-eoa` or `smart-account`
declaration uses its exact address for configuration reads. Sender-independent
resources use the zero address, so their configuration reads must not depend on
the eventual executor. Provider review cannot rewrite a reviewed postcondition.

A contract may declare an execution sender:

```json
{
  "sender": {
    "kind": "owner-eoa",
    "address": "0x..."
  }
}
```

`smart-account` declarations require both `accountId` and `address`, for example
`{ "kind": "smart-account", "accountId": "fleet", "address": "0xc3a56de6dfc1dcef5113927ec09513918e8c44aa" }`.
Obtain both from the chosen provider before planning. They are provider-neutral
and make the direct viem provider block. Absence means sender-independent; manifest authors must
not omit a sender when ownership, factory access, funding, or postconditions
depend on it.

Contracts may also require call-scope, expiry, and operation-limit enforcement.
The direct viem provider exposes interactive call review but no expiry or
operation-count enforcement, and blocks requirements it cannot satisfy.

## Evidence

Observation captures a block number/hash pair and pins every code, storage, or
static-call read to that exact canonical block. Failures and malformed
responses become structured `unreadable` cells; they are never absence or drift.

Provider finality and Moesi convergence are separate evidence boundaries. A
durable `submission-requested` fence is committed before every possible wallet
submission, and a returned provider reference is committed before observation.
Resume observes retained references without submitting them; a fence with no
reference stays ambiguous. After provider execution, Moesi captures a fresh
snapshot and verifies runtime bytecode, read-only call and storage attestations,
and managed configuration.
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
exact runtime hash plus every direct `requiresRuntime` target. Unreadable,
reorged, missing, or mismatched capability or prerequisite evidence leaves the
deployment pending and submits nothing; a later resume safely retries the same
gate.

Before provider preparation or submission, apply first proves that every
reviewed planning snapshot is still on the current chain. The built-in viem
adapter bounds a lineage walk to 4,096 blocks; an older plan is rejected before
signing and must be recreated.

## CLI

`plan --manifest` reads JSON or YAML 1.2; use `--manifest -` for stdin.
Equivalent documents produce the same normalized manifest and plan. Text is
limited to 1 MiB of UTF-8, with one document and no duplicate keys, aliases,
anchors, or explicit tags. Quote addresses, bytes, and decimal value strings in
YAML. Library consumers use `parseManifestText(source)` for the same boundary.

```sh
moesi plan \
  --manifest ./moesi.json \
  --chain 8453=https://rpc.example \
  --out ./plan.json

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

Planning exits 0 for converged, 2 for changes, and 3 for blocked, partial, or
pending state. Exit 2 still produces a valid saved plan. Handle it explicitly in scripts instead
of chaining `plan && apply` or using an unhandled planning command under `set -e`.
Use a new `--out` path
for each plan; existing files are never replaced. Run `moesi <command> --help`
for command-specific options and recovery guidance. Verification exits 0 for converged, 2 for drifted, and 3 for unreadable.
Inspection exits 0 for every valid plan disposition. Invalid input and planning
snapshot failures exit 1.
Each CLI RPC binding is checked with `eth_chainId` before observation; a URL on
the wrong chain cannot produce a mislabeled plan.

`verify` accepts only the saved reviewed plan and exact chain bindings. It
captures fresh pinned snapshots and checks runtime bytecode, read-only call and
storage attestations, and managed configuration without a provider, signer,
Run store, or transaction submission. Its result
is the versioned `moesi.verification-result/v4` artifact; status precedence is
unreadable, then drifted, then converged. Human plan, inspect, verify, and
first-pass apply-review output identify each resource as `managed` or
`external`; external resources are labeled verify-only with no execution
authority. Human inspection labels read-only evidence for either kind as
`manifest-call-check`, `call-check`, `call-check-observation`, or
`call-check-mismatch`; storage evidence uses corresponding
`manifest-storage-check`, `storage-check`, `storage-check-observation`, and
`storage-check-mismatch` labels.
Execution reviews retain every exact call and storage definition plus observed
blockers before showing an approval command.

`inspect` reads the saved `moesi.cli-plan/v6` artifact offline. Human output
expands its normalized manifest, pinned snapshots and factory capabilities,
runtime, configuration, and read-only call/storage evidence, ordered exact calls,
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

Execution has no implicit provider. `--provider viem` or `--provider oaath` is required, and
`--signer` accepts a chain-to-environment-variable binding rather than a key on
the command line. The first `apply` invocation is review-only: it creates no
Run and submits nothing. The accepted review digest binds the exact plan,
provider decision, confirmation policy, sender, and resolved store identity.

`resume` observes retained submitted references without a signer and without a
second send. If untouched pending work remains reachable, it requires signers
for the original reviewed requirements before continuing. Use `resume --observe-only`
for automatic confirmation: it never reviews, prepares, or submits operations,
and leaves untouched work pending with reason `pending-execution` and exit 3.
The library equivalent is `moesi.resume({ runId, provider, mode: "observe-only" })`.
Omitting `mode` continues pending work after its normal preflight.
A first SIGINT or
SIGTERM requests a durable-safe stop between effects; signal handlers are then
removed so a second signal retains the platform's hard-stop behavior.

## Verification

`bun run check` runs package-boundary checks, lint, build, typecheck, and unit suites.
`bun run check:boundaries` also exercises hostile temporary repositories: internal
or escaped SDK imports, cross-repository paths, copied AA implementation
indicators, dependency aliases, source symlinks, and invalid tarball checksums
must fail. The adapter imports only the public SDK root; the CLI dynamically
loads its optional adapter. These static regression checks support independent
review; they do not prove arbitrary obfuscated code harmless.

Normal package tests and standalone packed/local-Anvil scripts scrub inherited
RPC URLs, provider credentials, wallet variables and child-runtime preload
settings through `scripts/scrub-live-rpc-env.mjs`. Only an explicit toolchain and
system environment allowlist survives. Local endpoints and disposable fixture
accounts are created by each test after scrubbing. This isolates test inputs;
it is not an operating-system network sandbox.

`bun run smoke:packed` exercises both public tarballs from clean consumers.
Consumer installs reuse cached dependencies and may fetch missing npm registry
metadata or packages. `bun run audit:prod` checks only the shipped dependency graph. Install with
`bun install --frozen-lockfile --ignore-scripts`. Bun `1.4.2` manages the
workspace, scripts, and package tarballs. Use `bun run test` for the existing
Vitest suite. Workspace builds use Node `^22.18.0 || >=24.11.0`, matching the
pinned build tool; the public packages retain and are exercised at their
declared Node `>=22.13` runtime floor.

`bun run test:anvil` compiles local fixtures with `solc-js`, starts temporary Anvil,
and proves deployment, provider review, transaction observation, configuration
remediation, process-recreated CLI resume, and keyless fresh verification of
convergence and drift without contacting a shared RPC. It also installs the
packed `moesi` tarball into a clean consumer and proves the public
`moesi`/`moesi/viem` lifecycle from planning through one exact transaction,
provider observation, fresh verification, and a zero-action converged replan
without retaining a signer key.

The source packages are versioned together as `0.14.0`, with package-specific
release notes in [the changelog](CHANGELOG.md). Registry `0.13.0` already exists
and predates this completed rebuild; it must not be overwritten. The OAAth
adapter requires the matching `@oaath/sdk@0.3.0` public contract and development
uses the exact published tarballs with checksummed provenance.

Changesets owns versions, changelogs, and tags for the fixed group:

```sh
bun run changeset         # describe a change in a PR
bun run release:status    # pending release plan
bun run release:version   # versioning PR: consume changesets, refresh bun.lock
bun run release:check     # pack every public package; no publishing or tags
bun run release:publish   # owner only: publish the fixed group and tag it
```

Publish only from `main` after the versioning PR has merged; `release:publish`
publishes whatever versions the checkout carries. It builds, then uses Bun to
publish `moesi`, `@moesi/oaath`, and `@moesi/cli` in dependency order, resolving
workspace ranges to concrete ones, and finally runs `changeset tag`. Versions
already on npm are skipped, so an interrupted publish can be rerun. npm
two-factor prompts need an interactive terminal. The repository holds no
publishing credentials, and a versioned source commit does not imply npm
publication.

Sibling peer ranges stay open within 0.x (`>=0.15.0 <1.0.0`). Changesets bumps a
dependent to a major version whenever a peer range excludes the next version,
and in 0.x every minor would; the fixed group still releases in lockstep. All packages remain
`0.x.y`; before 1.0, obsolete contracts are removed instead of maintained through
compatibility layers.

The supported [checked beacon strategy](packages/moesi/README.md) compiles deterministic beacon/proxy creation and exact runtime-checked upgrades into ordinary reviewed manifests.
