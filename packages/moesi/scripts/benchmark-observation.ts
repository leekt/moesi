import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { type Address, keccak256 } from "viem";
import { createCetaneObserver } from "../src/cetane/index.js";
import { createMoesi, type MoesiManifest } from "../src/index.js";

// The script runs through scrub-live-rpc-env.mjs and never opens a network connection.
const resources = 32;
const checksPerResource = 4;
const latencyMs = 10;
const blockHash = `0x${"ab".repeat(32)}`;
const runtime = "0x6000";
const manifest: MoesiManifest = {
  version: "moesi.manifest/v7",
  contracts: Array.from({ length: resources }, (_, index) => ({
    kind: "external",
    id: `resource-${index.toString().padStart(2, "0")}`,
    address: `0x${(index + 1).toString(16).padStart(40, "0")}` as Address,
    expectedRuntimeCodeHash: keccak256(runtime),
    checks: Array.from({ length: checksPerResource }, (_, check) => ({
      id: `check-${check}`,
      caller: "0x1111111111111111111111111111111111111111",
      readData: `0x${check.toString(16).padStart(8, "0")}` as const,
      expectedResult: "0x01",
    })),
    storageChecks: [],
  })),
};

for (const batch of [false, true]) {
  const methods = new Map<string, number>();
  let exchanges = 0;
  let active = 0;
  let peak = 0;
  const observer = createCetaneObserver({
    chains: { 1: { rpcUrls: ["http://127.0.0.1:1"] } },
    concurrency: 8,
    retry: { attempts: 1 },
    batch,
    fetchFn: async (_url, init) => {
      exchanges++;
      peak = Math.max(peak, ++active);
      try {
        await pause(latencyMs);
        const input = JSON.parse(String(init?.body));
        const requests = Array.isArray(input) ? input : [input];
        const results = requests.map((rpc: { id: number; method: string; params: unknown[] }) => {
          methods.set(rpc.method, (methods.get(rpc.method) ?? 0) + 1);
          let result: unknown;
          switch (rpc.method) {
            case "eth_chainId":
              result = "0x1";
              break;
            case "eth_getBlockByNumber":
              result = { number: "0x64", hash: blockHash, parentHash: blockHash };
              break;
            case "eth_getCode":
            case "eth_call":
              assert.deepEqual(rpc.params.at(-1), { blockHash, requireCanonical: true });
              result = rpc.method === "eth_getCode" ? runtime : "0x01";
              break;
            default:
              throw new Error("unexpected_benchmark_rpc_method");
          }
          return { jsonrpc: "2.0", id: rpc.id, result };
        });
        return Response.json(Array.isArray(input) ? results : results[0]);
      } finally {
        active--;
      }
    },
  });
  const client = createMoesi({ observer });
  const started = performance.now();
  const plan = await client.plan({ manifest, chains: [1] });
  assert.equal(plan.cells.length, resources);
  assert(plan.cells.every((cell) => cell.status.kind === "converged"));
  assert(peak <= 8);
  report("plan", performance.now() - started, plan.planId);
  methods.clear();
  exchanges = 0;
  peak = 0;
  const verificationStarted = performance.now();
  const verified = await client.verify({ plan });
  assert.equal(verified.chains[0]?.status, "converged");
  assert(peak <= 8);
  report("verify", performance.now() - verificationStarted, plan.planId);

  function report(operation: string, duration: number, planId: string) {
    console.log(
      JSON.stringify({
        operation,
        batch,
        resources,
        checksPerResource,
        simulatedLatencyMs: latencyMs,
        durationMs: Math.round(duration),
        exchanges,
        rpcCalls: [...methods.values()].reduce((sum, count) => sum + count, 0),
        methods: Object.fromEntries(methods),
        peakHttpConcurrency: peak,
        planId,
      }),
    );
  }
}
