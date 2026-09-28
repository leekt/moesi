# Migrating fleet authoring from 0.9

Use `defineFleet` from `moesi/fleet` to compile TypeScript authoring into current
literal manifests. This replaces the old authoring API; it does not read old
manifest versions, upgrade old runs, or interpret `${...}` strings. Keep the
existing fleet's account address, deployment strategy, salts, constructor
arguments, and expected runtime hashes explicit.

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
