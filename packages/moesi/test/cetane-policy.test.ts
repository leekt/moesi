import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createCetaneObserver } from "../src/cetane/index.js";
import type { SnapshotReference } from "../src/observation/types.js";

const address = `0x${"11".repeat(20)}` as const;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
type Rpc = { id: number; method: string; params: unknown[] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture(reply: (rpc: Rpc) => unknown) {
  const calls: Rpc[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body) as Rpc | Rpc[];
    const batch = Array.isArray(input) ? input : [input];
    calls.push(...batch);
    const results = batch.map((rpc) => {
      const value = reply(rpc);
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        ...(value && typeof value === "object" && "error" in value ? value : { result: value }),
      };
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(input) ? results : results[0]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}
function standard(rpc: Rpc): unknown {
  if (rpc.method === "eth_chainId") return "0x1";
  if (rpc.method === "eth_getBlockByNumber") {
    const tag = rpc.params[0] as string;
    const n =
      ({ latest: 100, safe: 90, finalized: 80 } as Record<string, number>)[tag] ??
      Number(BigInt(tag));
    return { number: `0x${n.toString(16)}`, hash: hash(n), parentHash: hash(n - 1) };
  }
  return rpc.method === "eth_getStorageAt" ? hash(0) : "0x6000";
}

it.each(["latest", "safe", "finalized"] as const)(
  "pins the exact %s header across all reads",
  async (pin) => {
    const rpc = await fixture(standard);
    const observer = createCetaneObserver({ chains: { 1: { rpcUrls: [rpc.url], pin } } });
    const snapshot = (await observer.captureSnapshot(1)) as SnapshotReference;
    const n = { latest: 100, safe: 90, finalized: 80 }[pin];
    expect(snapshot).toEqual({ blockNumber: String(n), blockHash: hash(n) });
    const input = { chainId: 1, address, snapshot: { ...snapshot, chainId: 1 } };
    await observer.readCode(input);
    await observer.readCall({ ...input, target: address, caller: address, data: "0x12345678" });
    await observer.readStorage!({ ...input, slot: hash(0) });
    for (const call of rpc.calls.filter(({ method }) =>
      ["eth_getCode", "eth_call", "eth_getStorageAt"].includes(method),
    ))
      expect(call.params.at(-1)).toEqual({ blockHash: hash(n), requireCanonical: true });
    expect(
      rpc.calls
        .filter(({ method }) => method === "eth_getBlockByNumber")
        .map(({ params }) => params[0]),
    ).toEqual([pin]);
  },
);

it.each([
  null,
  { number: "0x50", hash: "0x00" },
  { error: { code: -32602, message: "unsupported tag" } },
])("fails closed on unsupported or invalid finalized evidence: %j", async (header) => {
  const rpc = await fixture((call) =>
    call.method === "eth_getBlockByNumber" ? header : standard(call),
  );
  const observer = createCetaneObserver({
    chains: { 1: { rpcUrls: [rpc.url], pin: "finalized" } },
    retry: { attempts: 2 },
  });
  await expect(observer.captureSnapshot(1)).rejects.toMatchObject({ code: "observation_failed" });
  expect(
    rpc.calls
      .filter(({ method }) => method === "eth_getBlockByNumber")
      .every(({ params }) => params[0] === "finalized"),
  ).toBe(true);
});

it("preserves the requested tag across chain mismatch failover and detects canonical drift", async () => {
  const wrong = await fixture((rpc) => (rpc.method === "eth_chainId" ? "0x2" : standard(rpc)));
  let reorg = false;
  const right = await fixture((rpc) =>
    reorg && rpc.method === "eth_getBlockByNumber"
      ? { number: "0x50", hash: hash(999), parentHash: hash(79) }
      : standard(rpc),
  );
  const observer = createCetaneObserver({
    chains: { 1: { rpcUrls: [wrong.url, right.url], pin: "finalized" } },
    retry: { attempts: 2 },
  });
  const snapshot = (await observer.captureSnapshot(1)) as SnapshotReference;
  expect(wrong.calls.map(({ method }) => method)).toEqual(["eth_chainId"]);
  expect(right.calls.at(-1)?.params[0]).toBe("finalized");
  reorg = true;
  expect(
    await observer.checkBlockAncestry!({
      chainId: 1,
      ancestor: snapshot,
      descendant: { ...snapshot, chainId: 1 },
    }),
  ).toBe(false);
});

it("retries malformed tagged evidence on another endpoint without downgrading", async () => {
  const wrong = await fixture((rpc) =>
    rpc.method === "eth_getBlockByNumber" ? null : standard(rpc),
  );
  const right = await fixture(standard);
  const observer = createCetaneObserver({
    chains: { 1: { rpcUrls: [wrong.url, right.url], pin: "safe" } },
    retry: { attempts: 2 },
  });
  expect(await observer.captureSnapshot(1)).toEqual({ blockNumber: "90", blockHash: hash(90) });
  for (const rpc of [wrong, right]) expect(rpc.calls.at(-1)?.params[0]).toBe("safe");
});

it.each([false, true])(
  "shares a hard caller budget across retries, failover and recreation (batch %s)",
  async (batch) => {
    let remaining = 5;
    const admitted: string[] = [];
    const admitRpc = (request: {
      readonly chainId: number;
      readonly endpoint: number;
      readonly methods: readonly string[];
    }) => {
      expect(Object.keys(request).sort()).toEqual(["chainId", "endpoint", "methods"]);
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.methods)).toBe(true);
      if (request.methods.length > remaining) return false;
      remaining -= request.methods.length;
      admitted.push(...request.methods);
      return true;
    };
    const failing = await fixture((rpc) =>
      rpc.method === "eth_getCode"
        ? { error: { code: -32603, message: "fixture state unavailable" } }
        : standard(rpc),
    );
    const healthy = await fixture(standard);
    const create = () =>
      createCetaneObserver({
        chains: { 1: { rpcUrls: [failing.url, healthy.url] } },
        batch,
        admitRpc,
        retry: { attempts: 8 },
      });
    const read = (observer: ReturnType<typeof create>) =>
      observer.readCode({
        chainId: 1,
        address,
        snapshot: { chainId: 1, blockNumber: "80", blockHash: hash(80) },
      });
    expect(await read(create())).toBe("0x6000");
    const exhausted = create();
    await expect(read(exhausted)).rejects.toMatchObject({
      code: "observation_budget_exhausted",
      cause: null,
    });
    await expect(read(exhausted)).rejects.toMatchObject({ code: "observation_budget_exhausted" });
    await expect(read(create())).rejects.toMatchObject({ code: "observation_budget_exhausted" });
    expect(admitted).toEqual([
      "eth_chainId",
      "eth_getCode",
      "eth_chainId",
      "eth_getCode",
      "eth_chainId",
    ]);
    expect(failing.calls.length + healthy.calls.length).toBe(5);
  },
);

it("charges every batched method atomically and stops queued reads on exhaustion", async () => {
  const rpc = await fixture(standard);
  let remaining = 3;
  const methods: string[][] = [];
  const observer = createCetaneObserver({
    chains: { 1: { rpcUrls: [rpc.url] } },
    batch: true,
    concurrency: 3,
    admitRpc(request) {
      methods.push([...request.methods]);
      if (request.methods.length > remaining) return false;
      remaining -= request.methods.length;
      return true;
    },
  });
  const settled = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      observer.readCode({
        chainId: 1,
        address,
        snapshot: { chainId: 1, blockNumber: "80", blockHash: hash(80) },
      }),
    ),
  );
  expect(
    settled.every(
      (result) =>
        result.status === "rejected" && result.reason.code === "observation_budget_exhausted",
    ),
  ).toBe(true);
  expect(methods).toEqual([["eth_chainId"], ["eth_getCode", "eth_getCode", "eth_getCode"]]);
  expect(rpc.calls.map(({ method }) => method)).toEqual(["eth_chainId"]);
});

it("dispatches nothing after cancellation and sanitizes a throwing admission hook", async () => {
  const rpc = await fixture(standard);
  let admissions = 0;
  const observer = createCetaneObserver({
    chains: { 1: { rpcUrls: [rpc.url] } },
    admitRpc(this: unknown) {
      expect(this).toBeUndefined();
      admissions++;
      throw new Error("secret URL and payload");
    },
  });
  const signal = AbortSignal.abort();
  await expect(observer.captureSnapshot(1, { signal })).rejects.toMatchObject({
    code: "observation_aborted",
  });
  expect(admissions).toBe(0);
  await expect(observer.captureSnapshot(1)).rejects.toMatchObject({
    code: "observation_budget_exhausted",
    message: "observation_budget_exhausted",
    cause: null,
  });
  expect(rpc.calls).toHaveLength(0);
  expect(admissions).toBe(1);
});

it.each(["eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getStorageAt"])(
  "propagates %s exhaustion through plan and verify",
  async (denied) => {
    const { createMoesi } = await import("../src/index.js");
    const { keccak256 } = await import("cetane/utils");
    const rpc = await fixture(standard);
    const manifest = {
      version: "moesi.manifest/v8" as const,
      contracts: [
        {
          kind: "external" as const,
          id: "fixture",
          address,
          expectedRuntimeCodeHash: keccak256("0x6000"),
          checks: [
            {
              id: "call",
              caller: address,
              readData: "0x12345678" as const,
              expectedResult: "0x6000" as const,
            },
          ],
          storageChecks: [{ id: "storage", slot: hash(0), expectedWord: hash(0) }],
        },
      ],
    };
    const setup = createMoesi({
      observer: createCetaneObserver({ chains: { 1: { rpcUrls: [rpc.url] } } }),
    });
    const plan = await setup.plan({ manifest, chains: [1] });
    const make = () =>
      createMoesi({
        observer: createCetaneObserver({
          chains: { 1: { rpcUrls: [rpc.url] } },
          admitRpc: ({ methods }) => !methods.includes(denied),
        }),
      });
    await expect(make().plan({ manifest, chains: [1] })).rejects.toMatchObject({
      code: "observation_budget_exhausted",
    });
    await expect(make().verify({ plan })).rejects.toMatchObject({
      code: "observation_budget_exhausted",
    });
  },
);

it("never replaces a finalized hash when canonical state becomes unavailable", async () => {
  const rpc = await fixture((call) =>
    call.method === "eth_getCode"
      ? { error: { code: -32000, message: "header not found" } }
      : standard(call),
  );
  const observer = createCetaneObserver({
    chains: { 1: { rpcUrls: [rpc.url], pin: "finalized" } },
    retry: { attempts: 2 },
  });
  const snapshot = (await observer.captureSnapshot(1)) as SnapshotReference;
  await expect(
    observer.readCode({ chainId: 1, address, snapshot: { ...snapshot, chainId: 1 } }),
  ).rejects.toMatchObject({
    code: "observation_failed",
    cause: { attempts: [{ category: "state-unavailable" }, { category: "state-unavailable" }] },
  });
  const reads = rpc.calls.filter(({ method }) => method === "eth_getCode");
  expect(reads).toHaveLength(2);
  for (const { params } of reads)
    expect(params.at(-1)).toEqual({ blockHash: hash(80), requireCanonical: true });
  expect(
    rpc.calls
      .filter(({ method }) => method === "eth_getBlockByNumber")
      .map(({ params }) => params[0]),
  ).toEqual(["finalized"]);
});
