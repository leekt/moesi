# Migrating fleet authoring from 0.9

Use `defineFleet` from `moesi/fleet` to compile TypeScript authoring into current
literal manifests. This replaces the old authoring API; it does not read old
manifest versions, upgrade old runs, or interpret `${...}` strings. Keep the
existing fleet's account address, deployment strategy, salts, constructor
arguments, and expected runtime hashes explicit.

Use [the artifact workflow](artifacts.md) to turn full Foundry, solc or Hardhat 3
output into literal creation bytes and runtime expectations. It retains compiler
provenance and requires explicit evaluation for constructor-dependent immutables.

| 0.9 authoring | Current fleet authoring |
| --- | --- |
| `per_chain` | `resource(chainId, ctx)` and `configure(chainId, ctx)` callbacks |
| Resource `chains` filter | Return `null` from its resource callback on excluded chains |
| `post_deploy.for_each` | Map typed application rows to `ctx.contract(id).rule(...)` |
| `batch: true` | `batch: { key, maxRows }`; each write encodes one row in each array |
| `verify.view/args/expect` | ABI-typed `read: { functionName, args }` and `expect` |
| `pending_peer` | `after: [ctx.deployedOn(peerChainId, resourceId)]` |
| `${kernel.address}` | `ctx.account("deployment").address`, using a caller-supplied account descriptor |
| `${contracts.X.address}` | `ctx.address("X")`, including lazy constructor dependencies |
| `${read:peer\|token\|decimals()}` | `await ctx.read({ chainId, address, caller, abi, functionName, args })` |
| Implicit owner/admin checks | Explicit `semanticChecks` or read-only `checks` on the resource |

`compile()` returns immutable `{ manifest, chains, reads }[]`. Identical literal
manifests share a group, each containing at most 32 chains. Chains where every
resource is excluded produce no plan input. Pass groups directly
to `moesi.plan(group)`. Compilation never installs permissions or submits a
transaction.

## Worked route-matrix migration

Keep route generation in the application: token registry overrides, native
sentinels, allowed peers, and product filters remain ordinary typed code. The
example below takes compiled bytecode and runtime hashes from your existing
artifact pipeline. Use actual runtime hashes, accounting for constructor
immutables and library links; an unpatched artifact hash may differ from deployed
code.

Constructor context also matters. SRA's `SRAFactory` creates a child contract
and embeds its address in `IMPLEMENTATION`. Evaluating its init code as an
ordinary creation `eth_call` derives that child from the wrong parent address.
Deploy the original init code through the actual deterministic factory and salt
on a local chain, then hash the resulting runtime. Preserve constructor reads
as pinned inputs too: `AcrossAdapter` embeds the SpokePool's
`wrappedNativeToken()` result. A live runtime mismatch must not be resolved by
blindly copying the observed hash into desired state.

```ts
import { defineFleet } from "moesi/fleet";
import { encodeDeployData, parseAbi, type Address, type Hex } from "viem";

const bookAbi = parseAbi([
  "constructor(address owner)",
  "function checkTargetToken(uint256 chain, address source, address target) view returns (uint8)",
  "function setTargetTokens(uint256[] chains, address[] sources, address[] targets, uint8[] decimals)",
]);
const tokenAbi = parseAbi(["function decimals() view returns (uint8)"]);

type Route = {
  peerChainId: number;
  source: Address;
  target: Address;
  // Provide a literal for native sentinels and configured token overrides.
  decimals?: number;
};

export function routesFleet(input: {
  chains: readonly number[];
  accountId: string;
  accountAddress: Address;
  bytecode: Hex;
  runtimeCodeHash: Hex;
  salt: Hex;
  routeItemsFor(chainId: number): readonly Route[];
}) {
  return defineFleet({
    chains: input.chains,
    accounts: {
      deployment: {
        kind: "smart-account",
        accountId: input.accountId,
        address: input.accountAddress,
      },
    },
    contracts: {
      ManagedAddressBook: {
        abi: bookAbi,
        resource: (_chain, ctx) => ({
          kind: "managed",
          sender: ctx.account("deployment"),
          deployment: {
            kind: "create2-factory-v1",
            salt: input.salt,
            initCode: encodeDeployData({
              abi: bookAbi,
              bytecode: input.bytecode,
              args: [ctx.account("deployment").address],
            }),
            value: "0",
            requiresRuntime: [],
          },
          expectedRuntimeCodeHash: input.runtimeCodeHash,
          semanticChecks: [{
            kind: "ownable-owner",
            id: "owner",
            caller: ctx.account("deployment").address,
            expectedOwner: ctx.account("deployment").address,
          }],
        }),
      },
    },
    async configure(chainId, ctx) {
      const book = ctx.contract("ManagedAddressBook");
      const rows = await Promise.all(input.routeItemsFor(chainId).map(async row => {
        const decimals = row.decimals ?? await ctx.read({
          chainId: row.peerChainId,
          address: row.target,
          caller: ctx.account("deployment").address,
          abi: tokenAbi,
          functionName: "decimals",
          args: [],
        });
        return book.rule({
          id: `route-${row.peerChainId}-${row.source}-${row.target}`,
          read: {
            functionName: "checkTargetToken",
            args: [BigInt(row.peerChainId), row.source, row.target],
          },
          expect: decimals,
          write: {
            functionName: "setTargetTokens",
            args: [[BigInt(row.peerChainId)], [row.source], [row.target], [decimals]],
          },
          batch: { key: "target-tokens", maxRows: 64 },
          after: [ctx.deployedOn(row.peerChainId, "ManagedAddressBook")],
        });
      }));
      return { ManagedAddressBook: rows };
    },
  });
}
```

Create an observer with explicit RPC bindings, then call
`await routesFleet(input).compile({ observer, signal })`. All referenced peer
resources must be defined in the fleet's chain set, even when you later plan
only one returned group. Runtime prerequisites use resource IDs in
`requiresRuntime`; referencing an address alone does not create a deployment
prerequisite.

Every live read uses an exact per-chain block pin. Identical requests share one
observation. RPC failures, malformed return data, and cancellation fail
compilation; they never silently become a default decimal value. Keep each
returned group's `reads` alongside its authoring export as provenance. Plans bind
the resulting literal bytes; they do not promise those values will update when
remote state changes. Recompile and replan when inputs change.

For CLI use, write `group.manifest` as the manifest JSON. Supply each
`group.chains` entry with `--chain`; supply prerequisite peer chains outside that
group with `--peer-chain`. These remote readers do not require signers.

## Batch and readiness behavior

A row's read remains independent. A satisfied row never enters the reviewed
write. Ready drifted rows with the same adjacent batch key merge in declaration
order, split at `maxRows`. Missing contracts schedule their deployment and all
ready configuration rows; constructor-established values are rechecked before
submission so already-satisfied writes can be skipped.

Each batched write must have zero value and one item in every ABI array. Primitive
arrays and tuple arrays are supported, including SRA's parallel `address[]` and
`(uint256,uint16,uint16,bool)[]` asset-fee arguments. Scalar writes such as
`setFeed(address,address,uint32,uint8)` use ordinary rules without `batch`.
Multiple named return values use the ABI's return tuple order; a single tuple
return uses its ABI-inferred tuple/object shape. No old string coercion applies:
use `bigint` for `uint256`, numbers for `uint8`/`uint16`, and actual booleans.

Missing peer bytecode produces `pending-peer`; unavailable RPC evidence or an
unexpected runtime produces `blocked-peer`. Replan after a pending peer appears.
Apply and resume recheck peer runtime and ancestry before submission. These are
separate-chain observations, not an atomic cross-chain operation.

## Preserve deployment addresses

Keep CREATE2 bytecode, constructor arguments, factory, and salt unchanged.
For protected CreateX CREATE3, use `kind: "createx-create3-v1"`, the original
11-byte `entropy`, and the exact original smart-account address in `sender`.
Changing an account ID does not stand in for pinning its address. The protected
Across adapter fixture reproduces
`0xafdea3e6716239482c2378a3bf6d24fbdd99b077` from the existing sender and entropy.
Use `predictManifestAddresses` for offline comparisons before planning.

Import an existing account through OAAth when an execution provider is needed.
Fleet authoring stores only its public account ID/address descriptor; it neither
creates accounts nor owns credentials. Save and inspect a new plan and provider
review for current execution; old plans and runs remain unsupported.

## Compare with the existing live fleet

Export a `moesi.fleet-baseline/v1` JSON file from the **existing application's**
resolved declarations. Use its current address predictor, route generator, ABI
encoding and desired values. Do not generate the baseline from the new manifest:
that would hide migration mistakes. The baseline contains public declarations,
not an old manifest, credentials, a cached observation, or execution authority.
`parseFleetBaseline` validates and freezes this export before any RPC access.

Each cell identifies one resource on one chain:

| Field | Value from the existing application |
| --- | --- |
| `chainId`, `resourceId`, `kind` | Numeric chain ID, stable resource name, `managed` or `external` |
| `address`, `expectedRuntimeCodeHash` | Independently predicted address and expected deployed code hash |
| `configuration` | Every repairable row: `id`, simulation `caller`, ABI `readData`, ABI `expectedResult`, and `after` peers |
| `checks` | Every read-only assertion: `id`, `target`, `caller`, `readData`, `expectedResult` |
| `storageChecks` | Every storage assertion: `id`, 32-byte `slot`, 32-byte `expectedWord` |

All arrays are required, including empty ones. `after` entries contain `chainId`,
`address`, and `expectedRuntimeCodeHash`. Include owner/admin checks explicitly.
External resources have an empty `configuration`. Use `encodeFunctionData` and
`encodeFunctionResult` with the existing ABI; expand every old `for_each` row
before exporting. Preserve each row's actual simulation caller. A resource with
no explicit sender uses the zero address for configuration reads in the new
manifest; use an explicit sender when the original caller was the account.
Read IDs may change during migration: rows are matched by their read kind,
target/caller/calldata or storage slot. Resource IDs must remain stable.

For each compiled group, save its manifest and compare it to the baseline:

```sh
moesi check-parity --manifest ./group.json --baseline ./fleet-baseline.json \
  --chain 8453=https://base-rpc.example \
  --peer-chain 42161=https://arbitrum-rpc.example --json > parity.json
```

Repeat `--chain` for every selected chain in that group. The baseline must contain
each selected chain; it may also contain the rest of the fleet. Bind prerequisite
chains outside the selected group with `--peer-chain`, including peers referenced
only by the baseline. Baselines accept JSON files up to 32 MiB. The manifest
accepts the same JSON/YAML input and `-` stdin option as `plan`.

The equivalent library call is
`await checkFleetParity({ ...group, baseline, observer, signal })`, imported from
`moesi/fleet`. It creates the candidate plan and observes both declarations at
one shared block pin per chain. The immutable report retains baseline/manifest
hashes, pins, candidate plan ID/disposition, peer readiness, both addresses,
expected values, actual values, safe observation causes, and structured
differences. It requires no signer, provider, approval, or Run store.

| Exit | Status | Meaning |
| --- | --- | --- |
| 0 | `match` | Declarations and readable live results agree |
| 2 | `different` | Addresses, runtime expectations, resources, reads, expected values, peer prerequisites or observed values differ |
| 3 | `unreadable` | At least one required observation cannot establish parity; other differences remain in the report |
| 1 | Input error | Invalid baseline, manifest, chain/peer bindings or arguments |

**Parity does not imply convergence.** Both sides can agree on the same drift or
pending peer. Check each cell's `liveState` and the candidate plan disposition;
plan, execute and verify repairs separately. Missing bytecode cannot establish
parity for required call/storage reads. The command compares declarations and
live state, not the old submission route or old write calldata. Inspect and
approve the new plan's exact calls before execution.
