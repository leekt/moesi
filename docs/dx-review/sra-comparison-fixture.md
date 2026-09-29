# SRA comparison fixture

This application-specific example runs in the isolated SRA checkout described
in [the acceptance record](sra-live-parity.md). Save the code as
`scripts/moesi-current-migration.ts` there; its application imports and `moesi-current` alias
are intentionally not dependencies of the Moesi workspace.

```ts
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { MoesiObservationError, predictManifestAddresses } from "moesi-current";
import { checkFleetParity, defineFleet, parseFleetBaseline } from "moesi-current/fleet";
import { createViemObserver } from "moesi-current/viem";
import {
  type Address,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  encodeFunctionResult,
  type Hex,
  keccak256,
  parseAbi,
} from "viem";
import { CHAINLINK_FEEDS, feedMaxAge } from "../src/data/chainlink-feeds.ts";
import {
  CHAINS,
  DEPLOYER,
  INITIATOR,
  INITIATOR_PERMISSIONS,
  NATIVE,
  staticTokenDecimals,
  TOKENS,
} from "../src/data/chains.ts";
import {
  ACROSS_INTEGRATOR_ID,
  DEFAULT_FEE_RECIPIENT,
  SENDER_CREATOR,
} from "../src/data/deploy-constants.ts";
import { computeExpected, TARGET_FEE_CONFIG } from "../src/lib/deploy.ts";
import {
  ACROSS_CREATE3_ENTROPY,
  ADDRESS_BOOK_SALT,
  FACTORY_SALT,
  FLASHSWAP_SALT,
  HANDLER_SALT,
  RELAY_SALT,
  RESOLVER_CREATE3_ENTROPY,
  routeItemsFor,
} from "../src/lib/manifest.ts";

const destination = "/tmp/moesi-sra-parity";
let evidence = JSON.parse(await readFile(`${destination}/live-pins.json`, "utf8"));
let saved = null;
try {
  saved = JSON.parse(await readFile(`${destination}/observation-cache.json`, "utf8"));
  evidence = saved.evidence;
} catch {}
const completed = new Set(saved?.completed ?? []);
const oldAddresses = computeExpected(DEPLOYER, INITIATOR);
const decimals = new Map(
  evidence.evidence.flatMap((c) =>
    c.reads.map((r) => [`${c.chainId}:${r.address.toLowerCase()}`, r.decimals]),
  ),
);
if (
  evidence.evidence.some((c) => !c.snapshot || c.reads.some((r) => typeof r.decimals !== "number"))
)
  throw new Error("incomplete-decimals-evidence");
const printedCodes = new Set();
async function traceFetch(input, init) {
  const response = await fetch(input, init);
  try {
    const body = await response.clone().json();
    for (const item of Array.isArray(body) ? body : [body])
      if (item.error && !printedCodes.has(item.error.code)) {
        printedCodes.add(item.error.code);
        const m = String(item.error.message).toLowerCase();
        console.log(
          JSON.stringify({
            stage: "rpc-category-evidence",
            code: item.error.code,
            requestLimitReached: /request limit reached/.test(m),
            perSecond: /per second|\/second/.test(m),
            historical: /historical|pruned|archive/.test(m),
            state: /state/.test(m),
            exceeded: /exceed/.test(m),
          }),
        );
      }
  } catch {}
  return response;
}
const source = createViemObserver({
  fetchFn: traceFetch,
  chains: Object.fromEntries(
    CHAINS.map((c) => [
      c.chainId,
      {
        rpcUrls: c.chainId === 42161 ? ["https://arbitrum-one-rpc.publicnode.com", c.rpc] : [c.rpc],
        pin: { lagBlocks: 10 },
      },
    ]),
  ),
  batch: true,
  concurrency: 8,
  timeoutMs: 8000,
  retry: { attempts: 3, rateLimitDelayMs: 1000 },
});
const callCache = new Map((saved?.calls ?? []).map(([k, v]) => [k, Promise.resolve(v)]));
const codeCache = new Map((saved?.codes ?? []).map(([k, v]) => [k, Promise.resolve(v)]));
const modeSource = createViemObserver({
  chains: { 34443: { rpcUrls: [byModeUrl()] } },
  concurrency: 1,
  timeoutMs: 8000,
  retry: { attempts: 3, rateLimitDelayMs: 1000 },
});
function byModeUrl() {
  return CHAINS.find((c) => c.chainId === 34443)!.rpc;
}
const persisted = async (cache) =>
  (
    await Promise.all(
      [...cache].map(async ([key, value]) => {
        try {
          return [key, await value];
        } catch {
          return null;
        }
      }),
    )
  ).filter(Boolean);
const checkpoint = async () =>
  writeFile(
    `${destination}/observation-cache.json`,
    JSON.stringify({
      evidence,
      completed: [...completed],
      calls: await persisted(callCache),
      codes: await persisted(codeCache),
    }) + "\n",
  );
const callKey = (r) =>
  `${r.chainId}:${r.snapshot.blockHash}:${r.target.toLowerCase()}:${r.caller.toLowerCase()}:${r.data.toLowerCase()}`;
const codeKey = (r) => `${r.chainId}:${r.snapshot.blockHash}:${r.address.toLowerCase()}`;
const memo = (cache, key, read) => {
  if (!cache.has(key)) cache.set(key, read());
  return cache.get(key);
};
const observer = {
  ...source,
  readCall: (r) =>
    memo(callCache, callKey(r), () => (r.chainId === 34443 ? modeSource : source).readCall(r)),
  readCode: (r) =>
    memo(codeCache, codeKey(r), () => (r.chainId === 34443 ? modeSource : source).readCode(r)),
  captureSnapshot: async (id: number) => {
    const pin = evidence.evidence.find((c) => c.chainId === id)?.snapshot;
    if (!pin) throw new Error("missing-fixed-pin");
    return { blockNumber: pin.blockNumber, blockHash: pin.blockHash };
  },
};
const snapshot = (id: number) => evidence.evidence.find((c) => c.chainId === id).snapshot;
const byId = new Map(CHAINS.map((c) => [c.chainId, c]));
const byKey = new Map(CHAINS.map((c) => [c.key, c]));
const sender = { kind: "smart-account", accountId: "sra-kernel-v33", address: DEPLOYER } as const;
const names = [
  "SRAHandler",
  "SRAFactory",
  "ManagedAddressBook",
  "RelayAdapter",
  "GenericFlashSwapRecipient",
  "AcrossAdapter",
  "MultiPairChainlinkResolver",
] as const;
const artifacts = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => [
      name,
      JSON.parse(await readFile(`src/data/artifacts/${name}.json`, "utf8")),
    ]),
  ),
);
const salts = {
  SRAHandler: HANDLER_SALT,
  SRAFactory: FACTORY_SALT,
  ManagedAddressBook: ADDRESS_BOOK_SALT,
  RelayAdapter: RELAY_SALT,
  GenericFlashSwapRecipient: FLASHSWAP_SALT,
};
const included = (name, chain) =>
  name === "AcrossAdapter"
    ? !!chain.spokePool
    : name === "MultiPairChainlinkResolver"
      ? (CHAINLINK_FEEDS[chain.key] ?? []).length > 0
      : true;
const constructorArgs = (name, chain, address, owner) => {
  const feeds = CHAINLINK_FEEDS[chain.key] ?? [];
  switch (name) {
    case "SRAHandler":
      return [SENDER_CREATOR, owner, 18];
    case "SRAFactory":
      return [address("SRAHandler"), owner, INITIATOR];
    case "ManagedAddressBook":
      return [owner];
    case "RelayAdapter":
      return [address("SRAHandler"), owner];
    case "GenericFlashSwapRecipient":
      return [address("SRAHandler")];
    case "AcrossAdapter":
      return [chain.spokePool, address("SRAHandler"), owner, ACROSS_INTEGRATOR_ID];
    case "MultiPairChainlinkResolver":
      return [
        owner,
        feeds.map((f) => f.asset),
        feeds.map((f) => f.aggregator),
        feeds.map(feedMaxAge),
        feeds.map((f) => f.tokenDecimals),
      ];
  }
};
const initCode = (name, chain, address, owner) =>
  encodeDeployData({
    abi: artifacts[name].abi,
    bytecode: artifacts[name].bytecode,
    args: constructorArgs(name, chain, address, owner),
  });
let stage = "local-runtime";
let local: ReturnType<typeof spawn> | undefined;
try {
  stage = "prefetch-live-state";
  for (const chain of CHAINS) {
    stage = `prefetch-${chain.key}`;
    if (completed.has(chain.chainId)) continue;
    for (const key of callCache.keys())
      if (key.startsWith(`${chain.chainId}:`)) callCache.delete(key);
    for (const key of codeCache.keys())
      if (key.startsWith(`${chain.chainId}:`)) codeCache.delete(key);
    const current = evidence.evidence.find((c) => c.chainId === chain.chainId);
    current.snapshot = {
      chainId: chain.chainId,
      ...((await source.captureSnapshot(chain.chainId)) as object),
    };
    const calls = [];
    const read = (name, fn, args = []) =>
      calls.push(
        observer.readCall({
          chainId: chain.chainId,
          target: oldAddresses[name],
          caller: DEPLOYER,
          data: encodeFunctionData({ abi: artifacts[name].abi, functionName: fn, args }),
          snapshot: snapshot(chain.chainId),
        }),
      );
    for (const name of names.filter((n) => included(n, chain))) {
      if (name !== "GenericFlashSwapRecipient")
        read(name, name === "SRAHandler" ? "admin" : "owner");
    }
    for (const r of routeItemsFor(chain))
      read("ManagedAddressBook", "checkTargetToken", [BigInt(r.chainId), r.src, r.tgt]);
    read("SRAHandler", "protocolFeeConfig");
    read("SRAHandler", "feeRecipient");
    for (const t of TOKENS.filter((t) => chain.tokens[t.key]))
      read("SRAHandler", "assetFeeConfigs", [chain.tokens[t.key]]);
    for (const r of INITIATOR_PERMISSIONS) read("SRAFactory", "initiators", [r.address]);
    for (const f of CHAINLINK_FEEDS[chain.key] ?? [])
      read("MultiPairChainlinkResolver", "feeds", [f.asset]);
    const tokenAbi = parseAbi(["function decimals() view returns (uint8)"]);
    for (const r of evidence.evidence.find((c) => c.chainId === chain.chainId).reads)
      calls.push(
        observer.readCall({
          chainId: chain.chainId,
          target: r.address,
          caller: DEPLOYER,
          data: encodeFunctionData({ abi: tokenAbi, functionName: "decimals" }),
          snapshot: snapshot(chain.chainId),
        }),
      );
    if (chain.spokePool)
      calls.push(
        observer.readCall({
          chainId: chain.chainId,
          target: chain.spokePool,
          caller: DEPLOYER,
          data: encodeFunctionData({
            abi: parseAbi(["function wrappedNativeToken() view returns (address)"]),
            functionName: "wrappedNativeToken",
          }),
          snapshot: snapshot(chain.chainId),
        }),
      );
    for (const address of [
      SENDER_CREATOR,
      "0x4e59b44847b379578588920cA78FbF26c0B4956C",
      "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed",
      ...names.filter((n) => included(n, chain)).map((n) => oldAddresses[n]),
    ])
      calls.push(
        observer.readCode({ chainId: chain.chainId, address, snapshot: snapshot(chain.chainId) }),
      );
    const results = await Promise.allSettled(calls);
    console.log(
      JSON.stringify({
        stage: "prefetch-complete",
        chainId: chain.chainId,
        reads: results.length,
        failed: results.filter((r) => r.status === "rejected").length,
        causes: [
          ...new Set(
            results
              .filter((r) => r.status === "rejected")
              .map((r) =>
                JSON.stringify(r.reason instanceof MoesiObservationError ? r.reason.cause : null),
              ),
          ),
        ].map((v) => JSON.parse(v)),
      }),
    );
    if (results.every((r) => r.status === "fulfilled")) completed.add(chain.chainId);
    await checkpoint();
    for (const r of current.reads) {
      const data = await observer.readCall({
        chainId: chain.chainId,
        target: r.address,
        caller: DEPLOYER,
        data: encodeFunctionData({ abi: tokenAbi, functionName: "decimals" }),
        snapshot: snapshot(chain.chainId),
      });
      const value = decodeFunctionResult({ abi: tokenAbi, functionName: "decimals", data });
      decimals.set(`${chain.chainId}:${r.address.toLowerCase()}`, value);
      r.decimals = value;
    }
  }
  await writeFile(
    `${destination}/live-pins.json`,
    JSON.stringify(
      { ...evidence, at: new Date().toISOString(), pinPolicy: "fresh-per-chain" },
      null,
      2,
    ) + "\n",
  );
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as any).port;
  await new Promise<void>((r) => listener.close(() => r()));
  local = spawn("anvil", ["--silent", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: "ignore",
  });
  const rpc = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    const value = await response.json();
    if (value.error) throw new Error("local-rpc-failure");
    return value.result;
  };
  for (let i = 0; i < 60; i++) {
    try {
      await rpc("eth_chainId", []);
      break;
    } catch {
      if (i === 59) throw new Error("local-start-failed");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const creatorCode = (await observer.readCode({
    chainId: 1,
    address: SENDER_CREATOR,
    snapshot: snapshot(1),
  })) as Hex;
  if (!creatorCode || creatorCode === "0x") throw new Error("sender-creator-missing");
  const creatorHash = keccak256(creatorCode);
  await rpc("anvil_setCode", [SENDER_CREATOR, creatorCode]);
  const create2Factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
  await rpc("anvil_setCode", [
    create2Factory,
    "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3",
  ]);
  await rpc("anvil_impersonateAccount", [DEPLOYER]);
  await rpc("anvil_setBalance", [DEPLOYER, "0x56bc75e2d63100000"]);
  const constructorReads = [];
  const runtimeHashes = new Map();
  const runtimeByInit = new Map();
  for (const chain of CHAINS) {
    for (const name of names) {
      if (!included(name, chain)) continue;
      stage = `local-runtime-${chain.key}-${name}`;
      const init = initCode(name, chain, (n) => oldAddresses[n], DEPLOYER);
      const cacheKey = name === "AcrossAdapter" ? `${chain.chainId}:${init}` : init;
      if (name === "AcrossAdapter") {
        const wrapAbi = parseAbi(["function wrappedNativeToken() view returns (address)"]);
        const word = (await observer.readCall({
          chainId: chain.chainId,
          target: chain.spokePool,
          caller: DEPLOYER,
          data: encodeFunctionData({ abi: wrapAbi, functionName: "wrappedNativeToken" }),
          snapshot: snapshot(chain.chainId),
        })) as Hex;
        if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw new Error("invalid-wrapped-native-token");
        constructorReads.push({
          chainId: chain.chainId,
          address: chain.spokePool,
          functionName: "wrappedNativeToken",
          value: word,
          snapshot: snapshot(chain.chainId),
        });
        await rpc("anvil_setCode", [chain.spokePool, `0x7f${word.slice(2)}60005260206000f3`]);
      }
      let runtime = runtimeByInit.get(cacheKey);
      if (!runtime) {
        if (name === "SRAFactory") {
          // The constructor embeds the address of a newly created SRA. Execute
          // at its actual CREATE2 address so that child address is correct.
          const tx = await rpc("eth_sendTransaction", [
            {
              from: DEPLOYER,
              to: create2Factory,
              data: FACTORY_SALT + init.slice(2),
              gas: "0xf42400",
            },
          ]);
          let receipt: { status: string } | null = null;
          for (let i = 0; i < 40; i++) {
            receipt = await rpc("eth_getTransactionReceipt", [tx]);
            if (receipt) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          if (receipt?.status !== "0x1") throw new Error("local-factory-deploy-failed");
          runtime = await rpc("eth_getCode", [oldAddresses.SRAFactory, "latest"]);
        } else
          runtime = await rpc("eth_call", [
            { from: DEPLOYER, data: init, gas: "0x1c9c380" },
            "latest",
          ]);
        if (typeof runtime !== "string" || runtime === "0x")
          throw new Error("empty-constructor-runtime");
        runtimeByInit.set(cacheKey, runtime);
      }
      runtimeHashes.set(`${chain.chainId}:${name}`, keccak256(runtime));
      await rpc("anvil_setCode", [oldAddresses[name], runtime]);
    }
  }
  local.kill("SIGTERM");
  await once(local, "exit");
  local = undefined;
  await writeFile(
    `${destination}/constructor-evidence.json`,
    JSON.stringify({ creatorHash, creatorSnapshot: snapshot(1), constructorReads }, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      stage: "local-runtime-complete",
      distinctConstructors: runtimeByInit.size,
      cells: runtimeHashes.size,
    }),
  );
  const ownerAbi = parseAbi(["function owner() view returns (address)"]);
  const adminAbi = parseAbi(["function admin() view returns (address)"]);
  const tokenAbi = parseAbi(["function decimals() view returns (uint8)"]);
  const checks = (name, target) =>
    name === "GenericFlashSwapRecipient"
      ? []
      : [
          {
            id: name === "SRAHandler" ? "admin" : "owner",
            target,
            caller: DEPLOYER,
            readData: encodeFunctionData({
              abi: name === "SRAHandler" ? adminAbi : ownerAbi,
              functionName: name === "SRAHandler" ? "admin" : "owner",
            }),
            expectedResult: encodeFunctionResult({
              abi: ownerAbi,
              functionName: "owner",
              result: DEPLOYER,
            }),
          },
        ];
  const oldRows = (name, chain) => {
    const row = (id, fn, args, result, after = []) => ({
      id,
      caller: DEPLOYER,
      readData: encodeFunctionData({ abi: artifacts[name].abi, functionName: fn, args }),
      expectedResult: encodeFunctionResult({ abi: artifacts[name].abi, functionName: fn, result }),
      after,
    });
    if (name === "ManagedAddressBook")
      return routeItemsFor(chain, (key, address) =>
        decimals.get(`${byKey.get(key)!.chainId}:${address.toLowerCase()}`),
      ).map((r, i) =>
        row(`old-route-${i}`, "checkTargetToken", [BigInt(r.chainId), r.src, r.tgt], r.decimals, [
          {
            chainId: r.chainId,
            address: oldAddresses.ManagedAddressBook,
            expectedRuntimeCodeHash: runtimeHashes.get(`${r.chainId}:ManagedAddressBook`),
          },
        ]),
      );
    if (name === "SRAFactory")
      return INITIATOR_PERMISSIONS.map((r, i) =>
        row(`old-initiator-${i}`, "initiators", [r.address], r.allowed),
      );
    if (name === "MultiPairChainlinkResolver")
      return (CHAINLINK_FEEDS[chain.key] ?? []).map((f, i) =>
        row(`old-feed-${i}`, "feeds", [f.asset], [f.aggregator, feedMaxAge(f), f.tokenDecimals]),
      );
    if (name === "SRAHandler")
      return [
        row(
          "old-protocol-fee",
          "protocolFeeConfig",
          [],
          [
            TARGET_FEE_CONFIG.protocolFeeBps,
            true,
            TARGET_FEE_CONFIG.allowOverride,
            TARGET_FEE_CONFIG.allowSponsored,
          ],
        ),
        row("old-recipient", "feeRecipient", [], DEFAULT_FEE_RECIPIENT),
        ...TOKENS.filter((t) => chain.tokens[t.key]).map((t, i) =>
          row(
            `old-asset-${i}`,
            "assetFeeConfigs",
            [chain.tokens[t.key]],
            [
              TARGET_FEE_CONFIG.thresholdUnits *
                10n ** BigInt(staticTokenDecimals(chain.key, t.key)),
              TARGET_FEE_CONFIG.belowBps,
              TARGET_FEE_CONFIG.aboveOrEqualBps,
              true,
            ],
          ),
        ),
      ];
    return [];
  };
  stage = "baseline";
  const baseline = parseFleetBaseline({
    version: "moesi.fleet-baseline/v1",
    cells: CHAINS.flatMap((chain) => [
      {
        chainId: chain.chainId,
        resourceId: "SenderCreator",
        kind: "external",
        address: SENDER_CREATOR,
        expectedRuntimeCodeHash: creatorHash,
        configuration: [],
        checks: [],
        storageChecks: [],
      },
      ...names
        .filter((name) => included(name, chain))
        .map((name) => ({
          chainId: chain.chainId,
          resourceId: name,
          kind: "managed",
          address: oldAddresses[name],
          expectedRuntimeCodeHash: runtimeHashes.get(`${chain.chainId}:${name}`),
          configuration: oldRows(name, chain),
          checks: checks(name, oldAddresses[name]),
          storageChecks: [],
        })),
    ]),
  });
  await writeFile(`${destination}/baseline.json`, JSON.stringify(baseline, null, 2) + "\n");
  stage = "compile";
  const fleet = defineFleet({
    chains: CHAINS.map((c) => c.chainId),
    accounts: { deployment: sender },
    contracts: {
      SenderCreator: {
        abi: [],
        resource: {
          kind: "external",
          address: SENDER_CREATOR,
          expectedRuntimeCodeHash: creatorHash,
        },
      },
      ...Object.fromEntries(
        names.map((name) => [
          name,
          {
            abi: artifacts[name].abi,
            resource: (chainId, ctx) => {
              const chain = byId.get(chainId);
              if (!included(name, chain)) return null;
              const isCreate3 = name === "AcrossAdapter" || name === "MultiPairChainlinkResolver";
              return {
                kind: "managed",
                sender: ctx.account("deployment"),
                deployment: {
                  kind: isCreate3 ? "createx-create3-v1" : "create2-factory-v1",
                  ...(isCreate3
                    ? {
                        entropy:
                          name === "AcrossAdapter"
                            ? ACROSS_CREATE3_ENTROPY
                            : RESOLVER_CREATE3_ENTROPY,
                      }
                    : { salt: salts[name] }),
                  initCode: initCode(
                    name,
                    chain,
                    (n) => ctx.address(n),
                    ctx.account("deployment").address,
                  ),
                  value: "0",
                  requiresRuntime: name === "SRAHandler" ? ["SenderCreator"] : [],
                },
                expectedRuntimeCodeHash: runtimeHashes.get(`${chainId}:${name}`),
                checks: checks(name, oldAddresses[name]).map(({ target, ...check }) => check),
              };
            },
          },
        ]),
      ),
    },
    async configure(chainId, ctx) {
      const chain = byId.get(chainId)!;
      const rows = {};
      const book = ctx.contract("ManagedAddressBook");
      rows.ManagedAddressBook = await Promise.all(
        routeItemsFor(chain).map(async (r, i) => {
          const d =
            r.tgt.toLowerCase() === NATIVE.toLowerCase()
              ? 18
              : await ctx.read({
                  chainId: r.chainId,
                  address: r.tgt,
                  caller: ctx.account("deployment").address,
                  abi: tokenAbi,
                  functionName: "decimals",
                  args: [],
                });
          return book.rule({
            id: `route-${i}`,
            read: { functionName: "checkTargetToken", args: [BigInt(r.chainId), r.src, r.tgt] },
            expect: d,
            write: {
              functionName: "setTargetTokens",
              args: [[BigInt(r.chainId)], [r.src], [r.tgt], [d]],
            },
            batch: { key: "routes", maxRows: 64 },
            after: [ctx.deployedOn(r.chainId, "ManagedAddressBook")],
          });
        }),
      );
      const handler = ctx.contract("SRAHandler");
      rows.SRAHandler = [
        handler.rule({
          id: "protocol-fee",
          read: { functionName: "protocolFeeConfig", args: [] },
          expect: [
            TARGET_FEE_CONFIG.protocolFeeBps,
            true,
            TARGET_FEE_CONFIG.allowOverride,
            TARGET_FEE_CONFIG.allowSponsored,
          ],
          write: {
            functionName: "setProtocolFee",
            args: [
              TARGET_FEE_CONFIG.protocolFeeBps,
              TARGET_FEE_CONFIG.allowOverride,
              TARGET_FEE_CONFIG.allowSponsored,
            ],
          },
        }),
        handler.rule({
          id: "fee-recipient",
          read: { functionName: "feeRecipient", args: [] },
          expect: DEFAULT_FEE_RECIPIENT,
          write: { functionName: "setFeeRecipient", args: [DEFAULT_FEE_RECIPIENT] },
        }),
        ...TOKENS.filter((t) => chain.tokens[t.key]).map((t, i) => {
          const fee = {
            threshold:
              TARGET_FEE_CONFIG.thresholdUnits *
              10n ** BigInt(staticTokenDecimals(chain.key, t.key)),
            belowBps: TARGET_FEE_CONFIG.belowBps,
            aboveOrEqualBps: TARGET_FEE_CONFIG.aboveOrEqualBps,
            isSet: true,
          };
          return handler.rule({
            id: `asset-${i}`,
            read: { functionName: "assetFeeConfigs", args: [chain.tokens[t.key]] },
            expect: [fee.threshold, fee.belowBps, fee.aboveOrEqualBps, fee.isSet],
            write: { functionName: "setAssetFeeConfigs", args: [[chain.tokens[t.key]], [fee]] },
            batch: { key: "asset-fees", maxRows: 64 },
          });
        }),
      ];
      rows.SRAFactory = INITIATOR_PERMISSIONS.map((r, i) =>
        ctx.contract("SRAFactory").rule({
          id: `initiator-${i}`,
          read: { functionName: "initiators", args: [r.address] },
          expect: r.allowed,
          write: { functionName: "setInitiator", args: [r.address, r.allowed] },
        }),
      );
      if (ctx.has("MultiPairChainlinkResolver"))
        rows.MultiPairChainlinkResolver = (CHAINLINK_FEEDS[chain.key] ?? []).map((f, i) =>
          ctx.contract("MultiPairChainlinkResolver").rule({
            id: `feed-${i}`,
            read: { functionName: "feeds", args: [f.asset] },
            expect: [f.aggregator, feedMaxAge(f), f.tokenDecimals],
            write: {
              functionName: "setFeed",
              args: [f.asset, f.aggregator, feedMaxAge(f), f.tokenDecimals],
            },
          }),
        );
      return rows;
    },
  });
  const groups = await fleet.compile({ observer });
  await mkdir(`${destination}/groups`, { recursive: true });
  console.log(
    JSON.stringify({
      stage: "compile-complete",
      groups: groups.length,
      cells: baseline.cells.length,
      configuration: baseline.cells.reduce((n, c) => n + c.configuration.length, 0),
    }),
  );
  const reports = [];
  for (const group of groups) {
    stage = `parity-${group.chains.join("-")}`;
    const predictions = predictManifestAddresses(group.manifest);
    for (const [name, address] of Object.entries(oldAddresses)) {
      const found = predictions.find((p) => p.resourceId === name);
      if (found && found.address.toLowerCase() !== address.toLowerCase())
        throw new Error("address-parity-mismatch");
    }
    await writeFile(
      `${destination}/groups/${group.chains.join("-")}.json`,
      JSON.stringify(group.manifest, null, 2) + "\n",
    );
    const report = await checkFleetParity({ ...group, baseline, observer });
    await writeFile(
      `${destination}/groups/${group.chains.join("-")}-parity.json`,
      JSON.stringify(report, null, 2) + "\n",
    );
    reports.push(report);
    console.log(
      JSON.stringify({
        stage,
        status: report.status,
        cells: report.chains.flatMap((c) => c.cells).length,
        differences: report.chains
          .flatMap((c) => c.cells)
          .reduce((n, c) => n + c.differences.length, 0),
      }),
    );
  }
  await writeFile(
    `${destination}/result.json`,
    JSON.stringify(
      {
        source: evidence.source,
        sourceVersion: "0.9.0",
        candidateCommit: "f265a60",
        at: new Date().toISOString(),
        addresses: oldAddresses,
        independentRuntimeConstructors: runtimeByInit.size,
        pinnedCallRequests: callCache.size,
        pinnedCodeRequests: codeCache.size,
        baselineCells: baseline.cells.length,
        baselineRows: baseline.cells.reduce((n, c) => n + c.configuration.length, 0),
        chains: reports.flatMap((r) =>
          r.chains.map((c) => ({
            chainId: c.chainId,
            status: r.status,
            snapshot: c.snapshot,
            plan: c.candidatePlan,
            cells: c.cells.map((cell) => ({
              id: cell.resourceId,
              address: cell.candidate?.address,
              baselineState: cell.baseline?.liveState,
              candidateState: cell.candidate?.liveState,
              rows: cell.candidate?.configuration.length,
              differences: cell.differences,
              unreadable: [
                ...(cell.candidate?.configuration ?? []),
                ...(cell.candidate?.checks ?? []),
              ]
                .filter((r) => r.observation.kind !== "readable")
                .map((r) => ({ id: r.id, observation: r.observation })),
            })),
          })),
        ),
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  console.error(
    JSON.stringify({
      stage,
      error:
        error instanceof MoesiObservationError
          ? error.code
          : typeof error?.code === "string"
            ? error.code
            : "migration-failed",
      ...(error instanceof MoesiObservationError ? { cause: error.cause } : {}),
    }),
  );
  process.exitCode = 1;
} finally {
  if (local) {
    local.kill("SIGTERM");
    await once(local, "exit");
  }
}
```
