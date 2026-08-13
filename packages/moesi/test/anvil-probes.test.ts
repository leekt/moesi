import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer } from "node:net";
import { createPublicClient, defineChain, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  batchCheckCode,
  batchOpcodeProbes,
  listKnownFeatures,
  OPCODE_PROBE_BYTECODES,
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
