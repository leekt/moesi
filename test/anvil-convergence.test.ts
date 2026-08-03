import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getCreate2Address,
  type Hex,
  http,
  keccak256,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRpcObservationAdapter } from "../packages/cli/src/rpc.js";
import { createDeploymentRun, createMoesi, type MoesiManifest } from "../src/index.js";

const CHAIN_ID = 31_337;
const TEST_ACCOUNT = "0x1000000000000000000000000000000000000001" as const;
const SALT = `0x${"42".repeat(32)}` as Hex;

const FACTORY_ABI = [
  {
    type: "constructor",
    inputs: [],
    stateMutability: "nonpayable",
  },
] as const;

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

describe.sequential("local Anvil convergence", () => {
  let anvil: ChildProcessWithoutNullStreams;
  let rpcUrl: string;
  let factory: CompiledContract;
  let configurable: CompiledContract;

  beforeAll(async () => {
    [factory, configurable] = await Promise.all([
      compile("contracts/MoesiCreate2Factory.sol", "MoesiCreate2Factory"),
      compile("contracts/test/Configurable.sol", "Configurable"),
    ]);
    const port = await availablePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(
      "anvil",
      ["--silent", "--auto-impersonate", "--chain-id", String(CHAIN_ID), "--port", String(port)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await waitForRpc(rpcUrl, anvil);
    await rpc(rpcUrl, "anvil_setBalance", [TEST_ACCOUNT, "0x56bc75e2d63100000"]);
  }, 20_000);

  afterAll(async () => {
    if (!anvil || anvil.exitCode !== null) return;
    anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      anvil.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
  });

  it("proves deploy, configuration drift, remediation, and convergence", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({
      chain,
      account: TEST_ACCOUNT,
      transport: http(rpcUrl),
    });
    const factoryHash = await walletClient.deployContract({
      abi: FACTORY_ABI,
      bytecode: factory.initCode,
    });
    const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryHash });
    if (!factoryReceipt.contractAddress) throw new Error("factory deployment lacked an address");

    const desiredResult = `0x${"0".repeat(62)}2a` as Hex;
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v1",
      contracts: [
        {
          id: "configurable",
          deployment: {
            kind: "create2-factory-v1",
            factory: factoryReceipt.contractAddress,
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
        },
      ],
    };
    const observer = createRpcObservationAdapter([{ chainId: CHAIN_ID, url: rpcUrl }], fetch);
    const moesi = createMoesi({ observer });
    const expectedAddress = getCreate2Address({
      from: factoryReceipt.contractAddress,
      salt: SALT,
      bytecodeHash: keccak256(configurable.initCode),
    });

    const deployPlan = await moesi.plan({ manifest, chains: [CHAIN_ID] });
    expect(deployPlan.cells[0]?.status.kind).toBe("missing");
    expect(deployPlan.steps.map(({ kind }) => kind)).toEqual(["deploy"]);

    const deployment = await createDeploymentRun({
      plan: deployPlan,
      observer,
      execute: executeSingleCall(walletClient, publicClient),
    }).wait();
    expect(deployment.chains[0]?.execution.kind).toBe("finalized");
    expect(deployment.chains[0]?.status).toBe("drifted");
    expect(deployment.chains[0]?.cells[0]?.configurations[0]?.status.kind).toBe("drifted");
    expect(await publicClient.getCode({ address: expectedAddress })).toBe(configurable.runtimeCode);

    const configurationPlan = await moesi.plan({ manifest, chains: [CHAIN_ID] });
    expect(configurationPlan.cells[0]?.status.kind).toBe("configuration-drift");
    expect(configurationPlan.steps.map(({ kind }) => kind)).toEqual(["configure"]);

    const remediation = await createDeploymentRun({
      plan: configurationPlan,
      observer,
      execute: executeSingleCall(walletClient, publicClient),
    }).wait();
    expect(remediation.status).toBe("converged");
    expect(remediation.chains[0]?.cells[0]?.configurations[0]?.status).toEqual({
      kind: "satisfied",
      observedResult: desiredResult,
    });

    const convergedPlan = await moesi.plan({ manifest, chains: [CHAIN_ID] });
    expect(convergedPlan.disposition).toBe("converged");
    expect(convergedPlan.steps).toEqual([]);
  }, 20_000);
});

function executeSingleCall(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
) {
  return async (batch: {
    readonly chainId: number;
    readonly calls: readonly { target: Address; data: Hex; value: bigint }[];
  }) => {
    const call = batch.calls[0];
    if (batch.chainId !== CHAIN_ID || batch.calls.length !== 1 || !call) {
      throw new Error("local proof expects one reviewed call on the Anvil chain");
    }
    const operationId = await walletClient.sendTransaction({
      account: TEST_ACCOUNT,
      chain: walletClient.chain,
      to: call.target,
      data: call.data,
      value: call.value,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: operationId });
    if (receipt.status !== "success")
      throw new Error("local transaction did not finalize successfully");
    return { chainId: CHAIN_ID, operationId };
  };
}

async function compile(path: string, contractName: string): Promise<CompiledContract> {
  const source = await readFile(path, "utf8");
  const input = JSON.stringify({
    language: "Solidity",
    sources: { [path]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  });
  const output = await runSolc(input);
  const artifact = output.contracts?.[path]?.[contractName];
  const initCode = artifact?.evm?.bytecode?.object;
  const runtimeCode = artifact?.evm?.deployedBytecode?.object;
  if (typeof initCode !== "string" || typeof runtimeCode !== "string") {
    throw new Error(`solc did not produce ${contractName}`);
  }
  return { initCode: `0x${initCode}`, runtimeCode: `0x${runtimeCode}` };
}

async function runSolc(input: string): Promise<SolcOutput> {
  const child = spawn("solc", ["--standard-json"], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  if (exitCode !== 0) throw new Error(`solc failed: ${Buffer.concat(stderr).toString("utf8")}`);
  const text = Buffer.concat(stdout).toString("utf8");
  return JSON.parse(text.slice(text.indexOf("{"))) as SolcOutput;
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
          readonly bytecode?: { object?: unknown };
          deployedBytecode?: { object?: unknown };
        };
      }
    >
  >;
}
