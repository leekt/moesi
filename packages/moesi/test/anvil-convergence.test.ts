import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getCreate2Address,
  type Hex,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
  createMoesi,
  MemoryDeploymentRunStore,
  type MoesiManifest,
  parseDeploymentRunRecord,
} from "../src/index.js";
import { createViemExecutionProvider, createViemObservationAdapter } from "../src/viem/index.js";

const CHAIN_ID = 31_337;
const ANVIL_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SALT = `0x${"42".repeat(32)}` as Hex;
const MISMATCH_SALT = `0x${"43".repeat(32)}` as Hex;
const CREATE2_FACTORY_RUNTIME =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

const CONFIGURABLE_ABI = [
  {
    type: "function",
    name: "value",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setValue",
    stateMutability: "nonpayable",
    inputs: [{ name: "nextValue", type: "uint256" }],
    outputs: [],
  },
] as const;

interface CompiledContract {
  readonly initCode: Hex;
  readonly runtimeCode: Hex;
}

describe.sequential("local Anvil viem convergence", () => {
  let anvil: ChildProcessWithoutNullStreams;
  let rpcUrl: string;
  let configurable: CompiledContract;

  beforeAll(async () => {
    configurable = await compile("Configurable.sol", "Configurable");
    const port = await availablePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--silent", "--chain-id", String(CHAIN_ID), "--port", String(port)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitForRpc(rpcUrl, anvil);
  }, 20_000);

  afterAll(async () => {
    if (!anvil || anvil.exitCode !== null) return;
    anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      anvil.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
  });

  it("plans, reviews, executes, observes, verifies, and converges through moesi/viem", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    expect(keccak256(CREATE2_FACTORY_RUNTIME)).toBe(CREATE2_FACTORY_V1_RUNTIME_CODE_HASH);
    await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, CREATE2_FACTORY_RUNTIME]);

    const desiredResult = `0x${"0".repeat(62)}2a` as Hex;
    const baseContract: MoesiManifest["contracts"][number] = {
      id: "configurable",
      deployment: {
        kind: "create2-factory-v1",
        salt: SALT,
        initCode: configurable.initCode,
        value: "0",
      },
      expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
      configuration: [
        {
          id: "value",
          readData: encodeFunctionData({ abi: CONFIGURABLE_ABI, functionName: "value" }),
          expectedResult: desiredResult,
          writeData: encodeFunctionData({
            abi: CONFIGURABLE_ABI,
            functionName: "setValue",
            args: [42n],
          }),
          value: "0",
        },
      ],
    };
    const observer = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const provider = createViemExecutionProvider({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
      walletClientForChain: (chainId) => (chainId === CHAIN_ID ? walletClient : undefined),
      confirmations: 1,
    });
    const moesi = createMoesi({ observer, runStore: new MemoryDeploymentRunStore() });
    const expectedAddress = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: SALT,
      bytecodeHash: keccak256(configurable.initCode),
    });

    const wrongSenderManifest: MoesiManifest = {
      version: "moesi.manifest/v1",
      contracts: [
        {
          ...baseContract,
          sender: { kind: "owner-eoa", address: "0x1000000000000000000000000000000000000001" },
        },
      ],
    };
    const wrongSenderPlan = await moesi.plan({
      manifest: wrongSenderManifest,
      chains: [CHAIN_ID],
    });
    const wrongSenderReview = await moesi.reviewExecution({ plan: wrongSenderPlan, provider });
    expect(wrongSenderReview.provider.status).toBe("blocked");
    expect(wrongSenderReview.provider.reasons).toContainEqual(
      expect.objectContaining({ code: "sender-mismatch", chainId: CHAIN_ID }),
    );

    const manifest: MoesiManifest = {
      version: "moesi.manifest/v1",
      contracts: [
        {
          ...baseContract,
          sender: { kind: "owner-eoa", address: account.address },
        },
      ],
    };
    const plan = await moesi.plan({ manifest, chains: [CHAIN_ID] });
    expect(plan.cells[0]?.status.kind).toBe("missing");
    expect(plan.steps.map(({ kind }) => kind)).toEqual(["deploy", "configure"]);
    expect(plan.requirements[0]?.calls).toEqual(plan.steps.map(({ call }) => call));
    const executionReview = await moesi.reviewExecution({ plan, provider });
    expect(executionReview.provider.status).toBe("supported");
    const deployment = await moesi.apply({ plan, provider, executionReview }).wait();
    expect(deployment.chains[0]?.execution.kind).toBe("finalized");
    expect(deployment.chains[0]?.execution).toMatchObject({
      steps: [{ stepId: "configurable:deploy" }, { stepId: "configurable:configure:value" }],
    });
    expect(deployment.status).toBe("converged");
    expect(deployment.chains[0]?.status).toBe("converged");
    expect(deployment.chains[0]?.cells[0]?.configurations[0]?.status).toEqual({
      kind: "satisfied",
      observedResult: desiredResult,
    });
    expect(await publicClient.getCode({ address: expectedAddress })).toBe(configurable.runtimeCode);

    const deploymentExecution = deployment.chains[0]?.execution;
    if (deploymentExecution?.kind !== "finalized" || !deploymentExecution.steps[0]) {
      throw new Error("deployment lacked a finalized reference");
    }
    await expect(
      provider.observe({ reference: deploymentExecution.steps[0].reference }),
    ).resolves.toMatchObject({ status: "finalized" });

    const convergedPlan = await moesi.plan({ manifest, chains: [CHAIN_ID] });
    expect(convergedPlan.disposition).toBe("converged");
    expect(convergedPlan.steps).toEqual([]);
  }, 30_000);

  it("blocks before submission when the reviewed factory runtime changes", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, CREATE2_FACTORY_RUNTIME]);
    const observer = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const provider = createViemExecutionProvider({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
      walletClientForChain: (chainId) => (chainId === CHAIN_ID ? walletClient : undefined),
      confirmations: 1,
    });
    const store = new MemoryDeploymentRunStore();
    const client = createMoesi({ observer, runStore: store });
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v1",
      contracts: [
        {
          id: "factory-gated",
          deployment: {
            kind: "create2-factory-v1",
            salt: MISMATCH_SALT,
            initCode: configurable.initCode,
            value: "0",
          },
          expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
          configuration: [],
          sender: { kind: "owner-eoa", address: account.address },
        },
      ],
    };
    const plan = await client.plan({ manifest, chains: [CHAIN_ID] });
    expect(plan.capabilities[0]?.status.kind).toBe("available");
    const executionReview = await client.reviewExecution({ plan, provider });
    expect(executionReview.provider.status).toBe("supported");
    const nonceBefore = await publicClient.getTransactionCount({ address: account.address });

    await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, "0x6001"]);
    try {
      const run = client.apply({ plan, provider, executionReview });
      const result = await run.wait();

      expect(result.chains[0]?.execution).toMatchObject({
        kind: "failed",
        reason: "deployment-capability-mismatch",
        steps: [],
      });
      expect(run.state).toBe("recovery-required");
      expect(await publicClient.getTransactionCount({ address: account.address })).toBe(
        nonceBefore,
      );
      expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
        { stepId: "factory-gated:deploy", phase: "pending" },
      ]);
    } finally {
      await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, CREATE2_FACTORY_RUNTIME]);
    }
  }, 30_000);
});

async function compile(fileName: string, contractName: string): Promise<CompiledContract> {
  const source = await readFile(new URL(`./fixtures/${fileName}`, import.meta.url), "utf8");
  const require = createRequire(import.meta.url);
  const solc = require("solc") as { readonly compile: (input: string) => string };
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { [fileName]: { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          outputSelection: {
            "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] },
          },
        },
      }),
    ),
  ) as SolcOutput;
  const artifact = output.contracts?.[fileName]?.[contractName];
  const initCode = artifact?.evm?.bytecode?.object;
  const runtimeCode = artifact?.evm?.deployedBytecode?.object;
  if (typeof initCode !== "string" || typeof runtimeCode !== "string") {
    throw new Error(`solc did not produce ${contractName}`);
  }
  return { initCode: `0x${initCode}`, runtimeCode: `0x${runtimeCode}` };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address();
  if (typeof value !== "object" || value === null) throw new Error("failed to reserve a port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return value.port;
}

async function waitForRpc(url: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Anvil exited before becoming ready");
    try {
      await rpc(url, "eth_chainId", []);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Anvil did not become ready");
}

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const value = (await response.json()) as { result?: unknown; error?: unknown };
  if (!response.ok || value.error !== undefined) throw new Error("local RPC request failed");
  return value.result;
}

interface SolcOutput {
  readonly contracts?: Record<
    string,
    Record<
      string,
      {
        readonly evm?: {
          readonly bytecode?: { readonly object?: unknown };
          readonly deployedBytecode?: { readonly object?: unknown };
        };
      }
    >
  >;
}
