import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { createPublicClient, defineChain, http } from "cetane";
import {
  createWalletClient,
  createPublicClient as referenceClient,
  http as referenceHttp,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BATCH_OPCODE_BYTECODE,
  batchCheckCode,
  batchOpcodeProbes,
  buildNicksTx,
  listKnownFeatures,
  OPCODE_PROBE_BYTECODES,
  predictNicksAddress,
  recoverNicksDeployer,
  runFeatureProbe,
} from "../src/index.js";

const CHAIN_ID = 31_341;
const FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const ABSENT = "0x00000000000000000000000000000000000000aa";

describe.sequential("local Anvil probes", () => {
  let anvil: ChildProcessWithoutNullStreams;
  let rpcUrl: string;
  let client: ReturnType<typeof createPublicClient>;

  beforeAll(async () => {
    const port = await availablePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--silent", "--chain-id", String(CHAIN_ID), "--port", String(port)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitForRpc(rpcUrl, anvil);
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi probe Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    client = createPublicClient({ chain, transport: http(rpcUrl) });
  }, 20_000);

  afterAll(async () => {
    if (!anvil || anvil.exitCode !== null) return;
    anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      anvil.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
  });

  it("reports deployment presence for many addresses through one state-override call", async () => {
    const result = await batchCheckCode(client, [FACTORY, ABSENT], { fallback: "none" });
    expect(result).toEqual({
      via: "state-override",
      count: 2,
      results: { [FACTORY]: true, [ABSENT]: false },
    });
  });

  it("answers the full opcode probe set in one call on a current-hardfork chain", async () => {
    const probes = Object.entries(OPCODE_PROBE_BYTECODES).map(([id, bytecode]) => ({
      id,
      bytecode,
    }));
    const outcomes = await batchOpcodeProbes(client, probes);
    expect(outcomes.push0).toBe(true);
    expect(outcomes.tload).toBe(true);
    expect(outcomes.mcopy).toBe(true);
    expect(outcomes.chainid).toBe(true);
    expect(Object.keys(outcomes)).toHaveLength(probes.length);
  });

  it("runs opcode, block-header, and contract-deployed feature probes", async () => {
    await expect(runFeatureProbe(client, "push0")).resolves.toEqual({ supported: true });
    await expect(runFeatureProbe(client, "baseFeeHeader")).resolves.toEqual({ supported: true });
    await expect(runFeatureProbe(client, "create2Proxy")).resolves.toEqual({ supported: true });
    expect(listKnownFeatures().some(({ id }) => id === "create2Proxy")).toBe(true);
  });

  it("does not let an existing account balance change MCOPY support evidence", async () => {
    const address = "0x000000000000000000000000000000000000c000";
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setBalance",
        params: [address, "0xde0b6b3a7640000"],
      }),
    });
    expect((await response.json()).error).toBeUndefined();
    expect(await runFeatureProbe(client, "mcopy")).toEqual({ supported: true });
  });

  it("does not let the helper address falsely report deployed code", async () => {
    const target = "0x000000000000000000000000000000000000bad0";
    expect(await client.getCode({ address: target })).toBe("0x");
    expect((await batchCheckCode(client, [target], { fallback: "none" })).results[target]).toBe(
      false,
    );
  });

  it("compiles the checked-in harness and isolates failing opcodes from later successes", async () => {
    const solc = createRequire(import.meta.url)("solc");
    const content = await readFile(new URL("./fixtures/OpcodeProbe.yul", import.meta.url), "utf8");
    const compiled = JSON.parse(
      solc.compile(
        JSON.stringify({
          language: "Yul",
          sources: { "OpcodeProbe.yul": { content } },
          settings: {
            evmVersion: "byzantium",
            optimizer: { enabled: true },
            outputSelection: { "*": { "*": ["evm.bytecode.object"] } },
          },
        }),
      ),
    );
    expect(`0x${compiled.contracts["OpcodeProbe.yul"].OpcodeProbe.evm.bytecode.object}`).toBe(
      BATCH_OPCODE_BYTECODE,
    );
    expect(
      await batchOpcodeProbes(client, [
        { id: "invalid", bytecode: "0xfe" },
        { id: "stop", bytecode: "0x00" },
      ]),
    ).toEqual({ invalid: false, stop: true });
  });

  it("verifies public precompile vectors while leaving authorization activation inconclusive", async () => {
    expect(await runFeatureProbe(client, "eip7702")).toEqual({
      supported: null,
      error: "inconclusive",
    });
    expect(await runFeatureProbe(client, "bls12381")).toEqual({ supported: true });
    expect(await runFeatureProbe(client, "rip7212")).toEqual({ supported: true });
    expect(await runFeatureProbe(client, "accessList")).toEqual({ supported: true });
  });

  it("accepts minimal Nick's-method signature quantities and deploys the predicted runtime", async () => {
    const params = {
      initCode: "0x6002600c60003960026000f36000" as const,
      gasPrice: 1_000_000_000n,
      r: `0x${"0".repeat(63)}1` as const,
      s: `0x${"0".repeat(63)}1` as const,
    };
    const deployer = await recoverNicksDeployer(params);
    const expectedAddress = predictNicksAddress(deployer);
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setBalance",
        params: [deployer, "0xde0b6b3a7640000"],
      }),
    });
    const wallet = createWalletClient({ transport: referenceHttp(rpcUrl) });
    // Never let a raw submission error print the serialized signature.
    const hash = await wallet
      .sendRawTransaction({ serializedTransaction: buildNicksTx(params) })
      .catch(() => null);
    expect(hash).not.toBeNull();
    if (hash === null) return;
    const receipt = await referenceClient({
      transport: referenceHttp(rpcUrl),
    }).waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(receipt.contractAddress?.toLowerCase()).toBe(expectedAddress.toLowerCase());
    expect(await client.getCode({ address: expectedAddress })).toBe("0x6000");
  });

  it("deploys an EIP-155 chain-bound Nick's transaction at the predicted address", async () => {
    const chainId = await client.getChainId();
    const params = {
      initCode: "0x6002600c60003960026000f36000" as const,
      gasPrice: 1_000_000_000n,
    };
    const wallet = createWalletClient({ transport: referenceHttp(rpcUrl) });
    const fund = async (address: string) =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "anvil_setBalance",
          params: [address, "0xde0b6b3a7640000"],
        }),
      });
    const bound = { ...params, chainId };
    const deployer = await recoverNicksDeployer(bound);
    // Each chain binding recovers a distinct keyless deployer.
    expect(await recoverNicksDeployer({ ...params, chainId: chainId + 1 })).not.toBe(deployer);
    expect(await recoverNicksDeployer(params)).not.toBe(deployer);
    const expectedAddress = predictNicksAddress(deployer);
    await fund(deployer);
    const hash = await wallet
      .sendRawTransaction({ serializedTransaction: buildNicksTx(bound) })
      .catch(() => null);
    expect(hash).not.toBeNull();
    if (hash === null) return;
    const receipt = await referenceClient({
      transport: referenceHttp(rpcUrl),
    }).waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(receipt.contractAddress?.toLowerCase()).toBe(expectedAddress.toLowerCase());
    expect(await client.getCode({ address: expectedAddress })).toBe("0x6000");
  });

  it("detects unsupported opcodes and precompiles on a pre-Shanghai chain without parsing errors", async () => {
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    const old = spawn("anvil", ["--silent", "--hardfork", "paris", "--port", String(port)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await waitForRpc(url, old);
      const oldClient = createPublicClient({ transport: http(url) });
      expect(
        await batchOpcodeProbes(oldClient, [
          { id: "push0", bytecode: "0x5f" },
          { id: "stop", bytecode: "0x00" },
        ]),
      ).toEqual({ push0: false, stop: true });
      expect(await runFeatureProbe(oldClient, "eip7702")).toEqual({
        supported: null,
        error: "inconclusive",
      });
      expect(await runFeatureProbe(oldClient, "bls12381")).toEqual({ supported: false });
      expect(await runFeatureProbe(oldClient, "rip7212")).toEqual({ supported: false });
    } finally {
      if (old.exitCode === null) {
        const exited = new Promise<void>((resolve) => old.once("exit", () => resolve()));
        old.kill("SIGTERM");
        await exited;
      }
    }
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
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
    if (child.exitCode !== null) throw new Error("anvil exited before becoming ready");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch {
      // Anvil is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("anvil never became ready");
}
