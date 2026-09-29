import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubCurrentProcessEnv } from "./scrub-live-rpc-env.mjs";

scrubCurrentProcessEnv();

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "moesi-packed-anvil-"));
const chainId = 31_339;
let anvil;

try {
  const packageDirectory = join(root, "packages/moesi");
  const packageManifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  const viemVersion = packageManifest.dependencies?.viem;
  if (typeof viemVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(viemVersion)) {
    throw new Error("packed_anvil_invalid_viem_version");
  }

  run("bun", ["pm", "pack", "--ignore-scripts", "--destination", temporary], packageDirectory);
  const tarballs = (await readdir(temporary)).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error("packed_anvil_tarball_count");
  const tarball = tarballs[0];
  if (tarball === undefined) throw new Error("packed_anvil_tarball_missing");

  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "moesi-packed-anvil-consumer",
        private: true,
        type: "module",
        dependencies: {
          moesi: `file:${join(temporary, tarball)}`,
          viem: viemVersion,
        },
      },
      null,
      2,
    )}\n`,
  );
  run("bun", ["install", "--prefer-offline", "--ignore-scripts"], consumer);

  const createXRuntime = (
    await readFile(join(root, "packages/moesi/test/fixtures/CreateX.runtime.hex"), "utf8")
  ).trim();
  await writeFile(join(consumer, "index.mjs"), consumerProgram({ chainId, createXRuntime }));

  await writeFile(
    join(consumer, "beacon-consumer.mjs"),
    await readFile(join(root, "scripts/fixtures/beacon-consumer.mjs"), "utf8"),
  );
  run(
    process.execPath,
    ["scripts/proxy-fixture.mjs", join(consumer, "beacon-fixtures.json")],
    join(root, "packages/moesi"),
  );

  const port = await availablePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn("anvil", ["--silent", "--chain-id", String(chainId), "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  anvil.stderr.resume();
  await waitForRpc(rpcUrl, anvil);

  const result = spawnSync(process.execPath, ["index.mjs"], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: {
      PATH: process.env.PATH ?? "",
      MOESI_PACKED_ANVIL_RPC: rpcUrl,
    },
  });
  if (result.error || result.status !== 0 || result.stdout !== "" || result.stderr !== "") {
    throw new Error("packed_anvil_consumer_failed");
  }
  const proxyResult = spawnSync(process.execPath, ["beacon-consumer.mjs"], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: { PATH: process.env.PATH ?? "", MOESI_PACKED_ANVIL_RPC: rpcUrl },
  });
  if (
    proxyResult.error ||
    proxyResult.status !== 0 ||
    proxyResult.stdout !== "" ||
    proxyResult.stderr !== ""
  ) {
    const code = /^proxy_[a-z_]+\n$/.test(proxyResult.stderr ?? "")
      ? proxyResult.stderr.trim()
      : "packed_proxy_consumer_failed";
    throw new Error(code);
  }
} finally {
  try {
    await stopAnvil(anvil);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function consumerProgram(input) {
  return `import {
  CREATEX_DEPLOY_CREATE2_SELECTOR,
  CREATEX_FACTORY_V1_ADDRESS,
  CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
  createMoesi,
  deriveCreateXSenderProtectedRawSalt,
  MemoryDeploymentRunStore,
  parseDeploymentRunRecord,
  parseReviewedPlan,
} from "moesi";
import { createViemExecutionProvider, createViemObservationAdapter } from "moesi/viem";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  http,
  keccak256,
} from "viem";

const assert = (condition) => {
  if (!condition) throw new Error("packed_anvil_assertion_failed");
};

async function main() {
  const moduleRoot = new URL("./node_modules/", import.meta.url).href;
  for (const specifier of ["moesi", "moesi/viem", "viem"]) {
    assert(import.meta.resolve(specifier).startsWith(moduleRoot));
  }

  const rpcUrl = process.env.MOESI_PACKED_ANVIL_RPC;
  assert(typeof rpcUrl === "string" && rpcUrl.startsWith("http://127.0.0.1:"));
  const chain = defineChain({
    id: ${input.chainId},
    name: "Moesi packed local Anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const accounts = await publicClient.request({ method: "eth_accounts" });
  const sender = accounts[0]?.toLowerCase();
  assert(typeof sender === "string" && /^0x[0-9a-f]{40}$/.test(sender));
  const walletClient = createWalletClient({ chain, account: sender, transport: http(rpcUrl) });
  assert(walletClient.account?.type === "json-rpc");

  assert(CREATEX_FACTORY_V1_ADDRESS === "0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed");
  assert(
    CREATEX_FACTORY_V1_RUNTIME_CODE_HASH ===
      "0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f",
  );
  assert(CREATEX_DEPLOY_CREATE2_SELECTOR === "0x26307668");
  const createXRuntime = ${JSON.stringify(input.createXRuntime)};
  assert(keccak256(createXRuntime) === CREATEX_FACTORY_V1_RUNTIME_CODE_HASH);
  await publicClient.request({
    method: "anvil_setCode",
    params: [CREATEX_FACTORY_V1_ADDRESS, createXRuntime],
  });
  assert(
    keccak256(await publicClient.getCode({ address: CREATEX_FACTORY_V1_ADDRESS })) ===
      CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
  );

  const entropy = "0x1234567890abcdef123456";
  const initCode = "0x600a600c600039600a6000f3602a60005260206000f3";
  const runtimeCode = "0x602a60005260206000f3";
  const rawSalt = concatHex([sender, "0x00", entropy]);
  assert(deriveCreateXSenderProtectedRawSalt({ sender, entropy }) === rawSalt);
  const guardedSalt = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [sender, rawSalt]),
  );
  const expectedAddress = getCreate2Address({
    from: CREATEX_FACTORY_V1_ADDRESS,
    salt: guardedSalt,
    bytecodeHash: keccak256(initCode),
  }).toLowerCase();
  const createXAbi = [{
    type: "function",
    name: "deployCreate2",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "initCode", type: "bytes" },
    ],
    outputs: [{ name: "newContract", type: "address" }],
  }];
  const expectedCallData = encodeFunctionData({
    abi: createXAbi,
    functionName: "deployCreate2",
    args: [rawSalt, initCode],
  });
  assert(expectedCallData.startsWith(CREATEX_DEPLOY_CREATE2_SELECTOR));

  const manifest = {
    version: "moesi.manifest/v6",
    contracts: [{
      kind: "managed",
      id: "packed-createx",
      deployment: {
        kind: "createx-create2-v1",
        entropy,
        initCode,
        value: "0",
        requiresRuntime: [],
      },
      expectedRuntimeCodeHash: keccak256(runtimeCode),
      checks: [],
      storageChecks: [],
      configuration: [],
      sender: { kind: "owner-eoa", address: sender },
    }],
  };
  const observer = createViemObservationAdapter({ publicClientForChain: () => publicClient });
  const provider = createViemExecutionProvider({
    publicClientForChain: () => publicClient,
    walletClientForChain: () => walletClient,
    confirmations: 1,
  });
  const store = new MemoryDeploymentRunStore();
  const client = createMoesi({ observer, runStore: store });
  const nonceBefore = await publicClient.getTransactionCount({ address: sender });
  const plan = await client.plan({ manifest, chains: [${input.chainId}] });
  const reloaded = parseReviewedPlan(JSON.parse(JSON.stringify(plan)));
  assert(plan.disposition === "changes");
  assert(plan.cells[0]?.address === expectedAddress);
  assert(plan.capabilities[0]?.kind === "createx-factory-v1");
  assert(plan.capabilities[0]?.status.kind === "available");
  assert(plan.steps.length === 1);
  assert(plan.steps[0]?.call.target === CREATEX_FACTORY_V1_ADDRESS);
  assert(plan.steps[0]?.call.data === expectedCallData);
  assert(plan.steps[0]?.sender?.kind === "reviewed-owner-eoa");
  assert(plan.steps[0]?.sender?.address === sender);
  assert(plan.requirements[0]?.sender.kind === "reviewed-owner-eoa");
  assert(plan.requirements[0]?.sender.address === sender);
  assert(plan.requirements[0]?.calls.length === 1);
  assert(plan.requirements[0]?.calls[0]?.target === CREATEX_FACTORY_V1_ADDRESS);
  assert(plan.requirements[0]?.calls[0]?.data === expectedCallData);
  assert(reloaded.planId === plan.planId);

  const review = await client.reviewExecution({ plan: reloaded, provider });
  assert(review.provider.status === "supported");
  assert(review.provider.chains[0]?.sender === sender);
  assert(review.provider.chains[0]?.route === "viem-direct-eoa:confirmations-1");
  assert(review.provider.chains[0]?.enforcement.calls === "interactive-owner");
  assert(review.provider.chains[0]?.enforcement.expiry === "not-enforced");
  assert(review.provider.chains[0]?.enforcement.operationCount === "not-enforced");
  assert(review.provider.reasons.length === 0);
  assert((await publicClient.getTransactionCount({ address: sender })) === nonceBefore);
  const run = client.apply({
    plan: reloaded,
    provider,
    executionReview: review,
    observeTiming: { attempts: 20, delayMs: 25 },
  });
  const result = await run.wait();
  assert(result.status === "converged");
  assert(result.chains[0]?.status === "converged");
  assert(result.chains[0]?.execution.kind === "finalized");
  assert(await publicClient.getCode({ address: expectedAddress }) === runtimeCode);
  assert((await publicClient.getTransactionCount({ address: sender })) === nonceBefore + 1);

  const execution = result.chains[0]?.execution;
  assert(execution?.kind === "finalized" && execution.operations.length === 1);
  const evidence = execution.operations[0];
  const reference = evidence?.reference;
  assert(reference?.providerId === "viem");
  const match = /^viem-tx-v1:(0x[0-9a-f]{64}):confirmations-1$/.exec(reference.reference);
  assert(match?.[1] !== undefined);
  assert(evidence.providerEvidence?.providerEvidenceId === match[1]);
  const record = parseDeploymentRunRecord(await store.get(run.runId));
  assert(record.operations.length === 1 && record.operations[0]?.phase === "finalized");
  const storedStep = record.operations[0];
  assert(storedStep?.phase === "finalized");
  assert(storedStep.reference.providerId === reference.providerId);
  assert(storedStep.reference.chainId === reference.chainId);
  assert(storedStep.reference.reference === reference.reference);
  assert(storedStep.providerEvidence.providerEvidenceId === match[1]);
  const transaction = await publicClient.getTransaction({ hash: match[1] });
  assert(transaction.hash === match[1]);
  assert(transaction.from.toLowerCase() === sender);
  assert(transaction.to?.toLowerCase() === CREATEX_FACTORY_V1_ADDRESS);
  assert(transaction.input === expectedCallData);
  assert(transaction.value === 0n);
  assert(transaction.nonce === nonceBefore);
  const observed = await provider.observe({ reference });
  assert(observed.status === "finalized");
  assert(observed.finalized?.sender === sender);
  assert(observed.finalized?.providerEvidenceId === match[1]);
  assert(observed.finalized?.calls[0]?.target === CREATEX_FACTORY_V1_ADDRESS);
  assert(observed.finalized?.calls[0]?.data === expectedCallData);
  assert(observed.finalized?.calls[0]?.value === "0");
  const nonceAfterExecution = await publicClient.getTransactionCount({ address: sender });
  assert(nonceAfterExecution === nonceBefore + 1);

  const recreatedObserver = createViemObservationAdapter({ publicClientForChain: () => publicClient });
  const recreated = createMoesi({ observer: recreatedObserver });
  const verification = await recreated.verify({ plan: reloaded });
  assert(verification.version === "moesi.verification-result/v4");
  assert(verification.planId === reloaded.planId);
  assert(verification.manifestHash === reloaded.manifestHash);
  assert(verification.status === "converged");
  assert(verification.chains.length === 1);
  assert(verification.chains[0]?.chainId === ${input.chainId});
  assert(verification.chains[0]?.status === "converged");
  assert(verification.chains[0]?.cells.length === 1);
  assert(verification.chains[0]?.cells[0]?.resourceId === "packed-createx");
  assert(verification.chains[0]?.cells[0]?.address === expectedAddress);
  assert(verification.chains[0]?.cells[0]?.status.kind === "satisfied");
  const convergedPlan = await recreated.plan({ manifest, chains: [${input.chainId}] });
  assert(convergedPlan.disposition === "converged");
  assert(convergedPlan.cells.length === 1);
  assert(convergedPlan.cells[0]?.resourceId === "packed-createx");
  assert(convergedPlan.cells[0]?.address === expectedAddress);
  assert(convergedPlan.cells[0]?.status.kind === "converged");
  assert(convergedPlan.steps.length === 0);
  assert(convergedPlan.requirements.length === 0);
  assert(convergedPlan.capabilities.length === 0);
  assert((await publicClient.getTransactionCount({ address: sender })) === nonceBefore + 1);
}

try {
  await main();
} catch {
  process.exitCode = 1;
}
`;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("packed_anvil_command_failed");
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("packed_anvil_port_unavailable");
  }
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForRpc(rpcUrl, child) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (finished(child)) throw new Error("packed_anvil_start_failed");
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(250),
      });
      const result = await response.json();
      if (result.result === `0x${chainId.toString(16)}`) return;
    } catch {
      // A fresh local Anvil may not have bound the loopback socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("packed_anvil_rpc_timeout");
}

async function stopAnvil(child) {
  if (!child || finished(child)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 2_000))) throw new Error("packed_anvil_stop_failed");
}

function finished(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (finished(child)) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(finished(child)), timeoutMs)),
  ]);
}

// The CI entry point exercises both independently packed provider paths.
await import("./smoke-packed-oaath.mjs");

await import("./run-examples.mjs");
