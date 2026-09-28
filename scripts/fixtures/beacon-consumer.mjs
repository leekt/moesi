import { readFile } from "node:fs/promises";
import {
  compileCheckedBeaconProxy,
  createMoesi,
  MemoryDeploymentRunStore,
  parseReviewedPlan,
} from "moesi";
import { createViemExecutionProvider, createViemObservationAdapter } from "moesi/viem";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
} from "viem";

const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};
const abi = parseAbi([
  "function initialize(address,uint256)",
  "function value() view returns (uint256)",
  "function owner() view returns (address)",
  "function version() view returns (uint256)",
  "function setValue(uint256)",
  "function implementation() view returns (address)",
  "function upgradeToChecked(address,bytes32)",
  "function upgradeTo(address)",
]);

async function main() {
  const rpcUrl = process.env.MOESI_PACKED_ANVIL_RPC;
  assert(typeof rpcUrl === "string" && rpcUrl.startsWith("http://127.0.0.1:"), "proxy_local_only");
  const moduleRoot = new URL("./node_modules/", import.meta.url).href;
  for (const specifier of ["moesi", "moesi/viem", "viem"])
    assert(import.meta.resolve(specifier).startsWith(moduleRoot), "proxy_package_isolation");
  const transport = http(rpcUrl);
  const probe = createPublicClient({ transport });
  const chain = defineChain({
    id: await probe.getChainId(),
    name: "Proxy proof",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport });
  const accounts = await publicClient.request({ method: "eth_accounts" });
  const owner = accounts[0].toLowerCase();
  const wallet = createWalletClient({ chain, account: owner, transport });
  const client = createMoesi({
    observer: createViemObservationAdapter({ publicClientForChain: () => publicClient }),
    runStore: new MemoryDeploymentRunStore(),
  });
  const provider = createViemExecutionProvider({
    publicClientForChain: () => publicClient,
    walletClientForChain: () => wallet,
    confirmations: 1,
  });
  const fixtures = JSON.parse(
    await readFile(new URL("./beacon-fixtures.json", import.meta.url), "utf8"),
  );
  const implementations = fixtures.map((fixture, index) => ({
    kind: "managed",
    id: `vault-v${index + 1}`,
    deployment: {
      kind: "create2-factory-v1",
      salt: `0x${String(index + 81).repeat(32)}`,
      initCode: fixture.initCode,
      value: "0",
      requiresRuntime: [],
    },
    expectedRuntimeCodeHash: keccak256(fixture.runtimeCode),
    configuration: [],
    checks: [],
    storageChecks: [],
  }));
  const input = {
    id: "vault",
    beaconSalt: `0x${"83".repeat(32)}`,
    proxySalt: `0x${"84".repeat(32)}`,
    owner,
    implementations,
    initialImplementationId: "vault-v1",
    desiredImplementationId: "vault-v1",
    initializationData: encodeFunctionData({ abi, functionName: "initialize", args: [owner, 17n] }),
  };
  const initial = compileCheckedBeaconProxy(input);
  const plan = parseReviewedPlan(
    JSON.parse(
      JSON.stringify(await client.plan({ manifest: initial.manifest, chains: [chain.id] })),
    ),
  );
  const wrongProvider = createViemExecutionProvider({
    publicClientForChain: () => publicClient,
    walletClientForChain: () => createWalletClient({ chain, account: accounts[1], transport }),
    confirmations: 1,
  });
  const nonceBefore = await publicClient.getTransactionCount({ address: owner });
  assert(
    (await client.reviewExecution({ plan, provider: wrongProvider })).provider.status === "blocked",
    "proxy_sender_not_blocked",
  );
  assert(
    (await publicClient.getTransactionCount({ address: owner })) === nonceBefore,
    "proxy_wrong_sender_sent",
  );
  const executionReview = await client.reviewExecution({ plan, provider });
  assert(executionReview.provider.status === "supported", "proxy_review_failed");
  assert(
    (await client.apply({ plan, provider, executionReview }).wait()).status === "converged",
    "proxy_initial_convergence",
  );
  assert(
    (await publicClient.getTransactionCount({ address: owner })) === nonceBefore + 4,
    "proxy_creation_send_count",
  );
  const read = (address, functionName) => publicClient.readContract({ address, abi, functionName });
  assert((await read(initial.proxyAddress, "value")) === 17n, "proxy_initializer_value");
  assert(
    (await read(initial.proxyAddress, "owner")).toLowerCase() === owner,
    "proxy_initializer_owner",
  );
  assert((await read(initial.proxyAddress, "version")) === 1n, "proxy_initial_version");
  assert((await client.verify({ plan })).status === "converged", "proxy_initial_verification");

  const upgrade = compileCheckedBeaconProxy({ ...input, desiredImplementationId: "vault-v2" });
  assert(
    upgrade.beaconAddress === initial.beaconAddress &&
      upgrade.proxyAddress === initial.proxyAddress,
    "proxy_address_changed",
  );
  const upgradePlan = await client.plan({ manifest: upgrade.manifest, chains: [chain.id] });
  assert(
    upgradePlan.steps.length === 1 &&
      upgradePlan.steps[0].id === "vault.beacon:configure:implementation",
    "proxy_upgrade_not_exact",
  );
  const v1 = plan.cells.find(({ resourceId }) => resourceId === "vault-v1").address;
  const v2 = plan.cells.find(({ resourceId }) => resourceId === "vault-v2").address;
  assert(
    upgradePlan.steps[0].call.data ===
      encodeFunctionData({
        abi,
        functionName: "upgradeToChecked",
        args: [v2, keccak256(fixtures[1].runtimeCode)],
      }),
    "proxy_upgrade_calldata",
  );
  const upgraded = await client
    .apply({
      plan: upgradePlan,
      provider,
      executionReview: await client.reviewExecution({ plan: upgradePlan, provider }),
    })
    .wait();
  assert(upgraded.status === "converged", "proxy_upgrade_convergence");
  assert(
    (await publicClient.getTransactionCount({ address: owner })) === nonceBefore + 5,
    "proxy_upgrade_send_count",
  );
  assert(
    (await read(initial.proxyAddress, "version")) === 2n &&
      (await read(initial.proxyAddress, "value")) === 17n,
    "proxy_storage_not_preserved",
  );
  assert(
    (await client.verify({ plan: upgradePlan })).status === "converged",
    "proxy_upgrade_verification",
  );
  assert((await client.verify({ plan })).status === "drifted", "proxy_old_desired_not_drifted");

  // Each negative case is mined with explicit gas: do not mistake failed estimation for an onchain guard.
  const revert = async (to, data, account = owner) => {
    const tx = await createWalletClient({ chain, account, transport }).sendTransaction({
      to,
      data,
      gas: 3_000_000n,
    });
    assert(
      (await publicClient.waitForTransactionReceipt({ hash: tx })).status === "reverted",
      "proxy_guard_did_not_revert",
    );
  };
  const guardedV1 = encodeFunctionData({
    abi,
    functionName: "upgradeToChecked",
    args: [v1, keccak256(fixtures[0].runtimeCode)],
  });
  await revert(initial.beaconAddress, guardedV1, accounts[1]);
  await revert(
    initial.beaconAddress,
    encodeFunctionData({ abi, functionName: "upgradeTo", args: [v1] }),
  );
  // The reviewed runtime can change after review; the exact write still cannot install it.
  await publicClient.request({ method: "anvil_setCode", params: [v1, "0x60006000f3"] });
  await revert(initial.beaconAddress, guardedV1);
  assert(
    (await read(initial.beaconAddress, "implementation")).toLowerCase() === v2,
    "proxy_bad_runtime_installed",
  );
  const badInitial = compileCheckedBeaconProxy({
    ...input,
    beaconSalt: `0x${"86".repeat(32)}`,
    proxySalt: `0x${"87".repeat(32)}`,
  });
  const badInitialBeacon = badInitial.manifest.contracts.find(({ id }) => id === "vault.beacon");
  await revert(
    "0x4e59b44847b379578588920ca78fbf26c0b4956c",
    concatHex([badInitialBeacon.deployment.salt, badInitialBeacon.deployment.initCode]),
  );
  assert(
    !(await publicClient.getCode({ address: badInitial.beaconAddress })),
    "proxy_bad_initial_runtime_deployed",
  );
  await publicClient.request({ method: "anvil_setCode", params: [v1, fixtures[0].runtimeCode] });

  const factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
  const sibling = compileCheckedBeaconProxy({ ...input, proxySalt: `0x${"85".repeat(32)}` });
  const siblingResource = sibling.manifest.contracts.find(({ id }) => id === "vault.proxy");
  const siblingCall = concatHex([
    siblingResource.deployment.salt,
    siblingResource.deployment.initCode,
  ]);
  // Same code and owner, but the beacon now selects v2: construction bound to v1 must revert.
  await revert(factory, siblingCall);
  assert(
    !(await publicClient.getCode({ address: sibling.proxyAddress })),
    "proxy_stale_beacon_deployed",
  );
  const restore = await wallet.sendTransaction({ to: initial.beaconAddress, data: guardedV1 });
  await publicClient.waitForTransactionReceipt({ hash: restore });
  await publicClient.request({ method: "anvil_setCode", params: [v1, "0x60006000f3"] });
  await revert(factory, siblingCall);
  assert(
    !(await publicClient.getCode({ address: sibling.proxyAddress })),
    "proxy_bad_initial_runtime_initialized",
  );
  await publicClient.request({ method: "anvil_setCode", params: [v1, fixtures[0].runtimeCode] });
  // The runtime gate does not authorize arbitrary code at the correct beacon address.
  const beaconCode = await publicClient.getCode({ address: initial.beaconAddress });
  await publicClient.request({
    method: "anvil_setCode",
    params: [initial.beaconAddress, "0x60006000f3"],
  });
  await revert(factory, siblingCall);
  await publicClient.request({
    method: "anvil_setCode",
    params: [initial.beaconAddress, beaconCode],
  });
  assert(
    !(await publicClient.getCode({ address: sibling.proxyAddress })),
    "proxy_bad_beacon_deployed",
  );
  // Exact restored prerequisites allow that same constructor and initializer to succeed.
  const siblingPlan = await client.plan({ manifest: sibling.manifest, chains: [chain.id] });
  assert(
    (
      await client
        .apply({
          plan: siblingPlan,
          provider,
          executionReview: await client.reviewExecution({ plan: siblingPlan, provider }),
        })
        .wait()
    ).status === "converged",
    "proxy_sibling_convergence",
  );
  assert((await read(sibling.proxyAddress, "value")) === 17n, "proxy_sibling_initialization");
}

try {
  await main();
} catch (error) {
  // Keep raw provider errors and request bodies out of CI output.
  const code =
    error instanceof Error && /^proxy_[a-z_]+$/.test(error.message)
      ? error.message
      : "proxy_consumer_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
