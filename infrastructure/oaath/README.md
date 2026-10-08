# OAAth testnet infrastructure

[421614.manifest.json](421614.manifest.json) observes OAAth's Arbitrum Sepolia
infrastructure (chain 421614, Kernel v4, EntryPoint 0.9). All 25 resources are
external: this manifest detects drift and produces no deployment, configuration,
funding or signing operations. It lives in Moesi; OAAth has no Moesi dependency.

| Resources | Reviewed expectations |
| --- | --- |
| EntryPoint, Kernel implementations and factory | Runtime hashes, factory implementation bindings, paymaster deposit floor |
| Validators, signers, policies, P256 verifier, CREATE2 deployer | Runtime hashes, including the deployed validity and resetting rate-limit policies |
| VerifyingPaymaster | Runtime hash, EntryPoint, sponsor signer, owner and pending owner |
| tUSD, tETH, DCA executor and fixed feeds | Runtime hashes, decimals, token/router/feed bindings, pool fee, maximum price age and fixed feed answers |
| Uniswap v3 factory, router, position manager and pool | Runtime hashes, factory owner, factory bindings, token order, pool fee and factory pool lookup |
| Multicall3 | Runtime hash, chain ID, bundle executor native balance floor |

The paymaster owner is `0x83c59dfb7376bad15e6d11b0e8c5f3b121d5f409` and its
sponsor signer is `0x5542551d208f39acf3ade2dc16ab38ae49e633af`. `pendingOwner()`
must remain zero. These contracts do not expose AccessControl roles: the manifest
checks the actual owner and signer views, without inventing `hasRole` assertions.
Kernel modules and the DCA executor have no global administrator to monitor.
The fixture tokens permit unrestricted minting; their feeds return fixed prices.
These pins identify that testnet behavior, not production token or oracle security.

## Configure the balance floors

Edit the `minimum` string in each resource's `semanticChecks` independently:

| Resource ID | Check ID | Balance source | Initial minimum |
| --- | --- | --- | --- |
| `entryPoint` | `paymaster-deposit` | `balanceOf(0x05f7a174cb907ae70a8b4b3930bd6fa2b1e2c0e3)` | `"10000000000000000"` (0.01 ETH) |
| `multicall3` | `bundle-executor-balance` | `getEthBalance(0x749c5a45fb069db0b96375ade0c8e39b658e46af)` | `"10000000000000000"` (0.01 ETH) |

Values are canonical integer strings in wei. Equality or excess passes; below
minimum is drift. A failed or malformed read is unreadable, not a zero balance.
The paymaster check monitors its EntryPoint deposit, not ETH held at the paymaster
address or its EntryPoint stake. Multicall3 is used only for its pinned balance
view; no multicall execution or caller substitution is involved.

Changing a floor changes the manifest hash and requires a new reviewed plan.
`verify` continues to enforce the settings retained in the plan it receives.
The initial values are editable operator settings, not hard-coded service policy.
No monitoring daemon, alert delivery or automatic top-up is installed by this
manifest; run the checks from your existing monitor and handle their exit status.

## Check drift

From this checkout, install with `bun install --frozen-lockfile --ignore-scripts`
and build with `bun run build`. Use the built CLI so it includes the minimum-check
schema (the published 0.15.4 CLI predates it):

```sh
mkdir -p .artifacts/oaath
bun packages/cli/dist/bin.js plan \
  --manifest infrastructure/oaath/421614.manifest.json \
  --chain 421614=https://sepolia-rollup.arbitrum.io/rpc \
  --out .artifacts/oaath/421614.plan.json
bun packages/cli/dist/bin.js verify \
  --plan .artifacts/oaath/421614.plan.json \
  --chain 421614=https://sepolia-rollup.arbitrum.io/rpc
```

Use `--json` for structured monitoring output. Both commands return 0 for
convergence. `plan` returns 3 when these external resources are blocked by drift
or unreadable evidence; `verify` returns 2 for drift and 3 for unreadable evidence.
With exclusively external resources there are no repair steps to apply. Inspect the structured
cell/check IDs before acting; an unreadable RPC response does not establish drift.
Run `plan` again after editing desired settings. Keep the chain ID explicit;
Multicall3's `getChainId()` assertion also checks the intended network.

For a bounded finalized observation job, use the public SDK:

```js
import { readFile } from "node:fs/promises";
import { createMoesi, parseManifest } from "moesi";
import { createCetaneObserver } from "moesi/cetane";

const manifest = parseManifest(JSON.parse(await readFile(
  "infrastructure/oaath/421614.manifest.json", "utf8",
)));
let remaining = 160;
const counts = new Map();
const observer = createCetaneObserver({
  chains: { 421614: {
    rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
    pin: "finalized",
  } },
  concurrency: 4,
  retry: { attempts: 1 },
  admitRpc: ({ methods }) => {
    if (methods.length > remaining) return false;
    remaining -= methods.length;
    for (const method of methods) counts.set(method, (counts.get(method) ?? 0) + 1);
    return true;
  },
});
const moesi = createMoesi({ observer });
const plan = await moesi.plan({ manifest, chains: [421614], signal: AbortSignal.timeout(60_000) });
console.log({ disposition: plan.disposition, counts: Object.fromEntries(counts) });
```

A monitor should persist the returned plan or fresh verification projection for
readers, and admit its next bounded job at an explicit later interval. A denied
budget stops the current observer; recreating it in a tight loop is not a retry
policy. Counts cover RPC methods, including identity and canonicality reads;
HTTP batching does not lower the method count. CLI defaults use a pinned latest
block; the SDK example explicitly chooses finalized state.

## Provenance and proof

[421614.provenance.json](421614.provenance.json) records the initial finalized
block, each deployed runtime hash and its evidence basis, source revisions,
and a subsequent public-API plan/verification observation. Pins with
`source-artifact-and-finalized-rpc` matched the OAAth artifact or module constant;
`finalized-rpc` pins record deployed bytes without claiming reproducible builds.
Uniswap addresses came from its [Arbitrum deployment documentation](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments).
The source review and capture were read-only; no credentials, keys or signed
transactions are included.

The recorded plan and fresh verification converged for 25 runtimes and 30 calls
at finalized block 317093075. That is historical evidence, not a perpetual health
claim. Re-run against the intended chain before relying on current state. Update
pins only after reviewing a deliberate deployment or authority change; do not
replace desired values with whatever a failing endpoint reports.

`bun run check` includes network-free regressions using this manifest's actual
addresses, callers, calldata, authority checks and floors. Those tests substitute
fixture runtime hashes and exercise balance drops, malformed reads, independent
setting changes, authority changes, bytecode replacement and wrong-chain state.
The packed local-Anvil suite separately proves minimum balance reads through real
EVM execution. Automated checks never call the shared Arbitrum RPC.
