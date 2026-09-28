# Run the public-package examples

For a small CLI authoring example, use [minimal.manifest.json](minimal.manifest.json):

```sh
pnpm exec moesi plan --manifest examples/minimal.manifest.json \
  --chain 8453=https://rpc.example --out ./plan.json
pnpm exec moesi inspect --plan ./plan.json
```

Supply your intended chain's RPC. Planning is read-only and exits 2 when changes
are found; it still saves the plan. The example deploys a tiny contract with no
application functions. Use a new output path to create another plan.

From the repository root, with Node/pnpm versions from `package.json` and
`anvil` on PATH:

```sh
pnpm install --frozen-lockfile
pnpm examples:local
# Or select one:
pnpm examples:local minimal-viem
pnpm examples:local minimal-oaath
pnpm examples:local multichain-oaath
pnpm examples:local drift-repair
```

The runner builds and packs the current packages, installs temporary consumers
outside the workspace, starts owned loopback Anvil chains, executes the examples,
and removes its temporary files/processes. It scrubs inherited RPC settings and
provider credentials; no live RPC configuration is needed. Package installation
may access the npm registry. CI runs the same examples through the packed onchain
gate.

| Example | Outcome |
| --- | --- |
| [minimal-viem](minimal-viem/main.mjs) | Plan and deploy one contract through an ordinary viem WalletClient, then verify convergence. OAAth is absent from this consumer. |
| [minimal-oaath](minimal-oaath/main.mjs) | Execute the same manifest through an explicitly authorized OAAth provider, with one approval and one submission. |
| [multichain-oaath](multichain-oaath/main.mjs) | One plan and one all-chain Grant deploy the same deterministic address on two chains, with one submission per chain. |
| [drift-repair](drift-repair/main.mjs) | Deploy desired value 42, change it to 7 externally, observe drift, review one exact repair and verify value 42 again. OAAth is absent. |

Each `main.mjs` exports a small `run` function. The two basic provider paths use
[the same literal manifest](shared/manifest.mjs). The drift example includes a
permissionless demonstration contract and bytecode compiled with solc 0.8.30,
Shanghai and optimizer 200 runs. Application code imports only public `moesi`,
`moesi/viem`, `@moesi/oaath` and `viem` APIs.

To use a workflow in your own application, copy its directory and `shared` if
imported, install the public packages, and call `run` with your own clients. The
viem examples take `{ publicClient, walletClient }`; the single-chain OAAth
example takes `{ oaath, publicClient }`; the multichain example takes
`{ oaath, publicClients: Map<number, PublicClient> }`. Clients must carry their
chain definition. Keep SDK configuration, custody, RPC selection and lifecycle
in the application. Close the supplied clients/SDK when your application is done.

The local runner uses `@oaath/testing/anvil` for OAAth setup. That test package
owns the local authorization and protocol fixture; it is not application signing
custody. Current development uses the exact checksummed SDK tarballs under
`vendor/oaath`, because registry `@oaath/sdk@0.1.0` lacks the required public APIs.
Use matching supported releases when available, or these exact tarballs for a
local consumer; do not import a sibling repository's source.

These examples automatically accept their known local plans at the commented
review checkpoint. In an application, present the exact plan and provider review
there before apply. `reviewExecution` signs and submits nothing. OAAth permission
consent is the separate `requestOAAthPlanPermission` call. Provider enforcement
is different: viem reports interactive owner review, while this OAAth fixture
reports onchain calls, expiry and operation-count enforcement.

All examples call `verify` after execution: provider finality alone is not
Moesi deployment convergence. They use `MemoryDeploymentRunStore` for a short
local journey; they do not demonstrate durable process recovery. For durable
Runs supply a store implementing atomic create and revision compare-and-swap,
or use the CLI file store. Changing the plan or provider requires a new execution
review; observation never authorizes a blind resend.
