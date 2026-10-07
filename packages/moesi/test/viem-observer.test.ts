import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256 } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMoesi, type MoesiManifest, parseReviewedPlan } from "../src/index.js";
import { MoesiObservationError, parseObservationCause } from "../src/observation/failure.js";
import { createViemObserver } from "../src/viem/index.js";

const HASH = `0x${"ab".repeat(32)}` as const;
const PARENT = `0x${"cd".repeat(32)}` as const;
const ADDRESS = "0x1111111111111111111111111111111111111111";
const SNAPSHOT = { chainId: 1, blockNumber: "100", blockHash: HASH };
type Rpc = { id: number; method: string; params?: unknown[] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function endpoint(
  handle?: (rpc: Rpc, response: ServerResponse) => unknown | Promise<unknown>,
) {
  const requests: { method: string; params: unknown[] }[] = [];
  const batches: number[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const parsed = JSON.parse(body) as Rpc | Rpc[];
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    batches.push(batch.length);
    const output = [];
    for (const rpc of batch) {
      requests.push({ method: rpc.method, params: rpc.params ?? [] });
      const result = handle ? await handle(rpc, res) : standard(rpc);
      if (res.writableEnded || res.destroyed) return;
      output.push({
        jsonrpc: "2.0",
        id: rpc.id,
        ...(result && typeof result === "object" && "error" in result ? result : { result }),
      });
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(parsed) ? output : output[0]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, batches };
}
function standard(rpc: Rpc) {
  if (rpc.method === "eth_chainId") return "0x1";
  if (rpc.method.startsWith("eth_getBlock"))
    return {
      number: rpc.params?.[0] === "latest" ? "0x64" : rpc.params?.[0],
      hash: HASH,
      parentHash: PARENT,
    };
  return rpc.method === "eth_getCode" ? "0x6000" : "0x";
}
function manifest(count = 0): MoesiManifest {
  return {
    version: "moesi.manifest/v6",
    contracts: [
      {
        kind: "external",
        id: "counter",
        address: ADDRESS,
        expectedRuntimeCodeHash: keccak256("0x6000"),
        checks: Array.from({ length: count }, (_, i) => ({
          id: `check-${i}`,
          caller: ADDRESS,
          readData: "0x12345678",
          expectedResult: "0x01",
        })),
        storageChecks: [],
      },
    ],
  };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("URL-only viem observation", () => {
  it.each([false, true])(
    "shares overlapping identity checks and revalidates later reads (batch: %s)",
    async (batch) => {
      let identity = "0x1";
      const rpc = await endpoint(async (request) => {
        if (request.method === "eth_chainId") {
          await pause(10);
          return identity;
        }
        return standard(request);
      });
      const observer = createViemObserver({
        chains: { 1: { rpcUrls: [rpc.url] } },
        batch,
        retry: { attempts: 1 },
      });
      const read = () => observer.readCode({ chainId: 1, address: ADDRESS, snapshot: SNAPSHOT });
      expect(await Promise.all(Array.from({ length: 8 }, read))).toEqual(Array(8).fill("0x6000"));
      expect(rpc.requests.filter(({ method }) => method === "eth_chainId")).toHaveLength(1);
      expect(rpc.requests.filter(({ method }) => method === "eth_getCode")).toHaveLength(8);
      await read();
      expect(rpc.requests.filter(({ method }) => method === "eth_chainId")).toHaveLength(2);
      identity = "0x2";
      await expect(read()).rejects.toMatchObject({
        cause: { attempts: [{ category: "chain-mismatch" }] },
      });
      expect(rpc.requests.filter(({ method }) => method === "eth_getCode")).toHaveLength(9);
    },
  );

  it("keeps shared identity checks isolated by cancellation scope", async () => {
    let release!: () => void;
    const identityPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rpc = await endpoint(async (request) => {
      if (request.method === "eth_chainId") await identityPending;
      return standard(request);
    });
    const observer = createViemObserver({
      chains: { 1: { rpcUrls: [rpc.url] } },
      batch: true,
    });
    const controller = new AbortController();
    const read = (signal?: AbortSignal) =>
      observer.readCode({
        chainId: 1,
        address: ADDRESS,
        snapshot: SNAPSHOT,
        ...(signal ? { signal } : {}),
      });
    const cancelled = Promise.all([read(controller.signal), read(controller.signal)]);
    const rejected = expect(cancelled).rejects.toMatchObject({ code: "observation_aborted" });
    const unaffected = read();
    try {
      await vi.waitFor(() =>
        expect(rpc.requests.filter(({ method }) => method === "eth_chainId")).toHaveLength(2),
      );
      controller.abort();
      await rejected;
    } finally {
      release();
    }
    expect(await unaffected).toBe("0x6000");
    expect(await read()).toBe("0x6000");
  });

  it("retries a failed shared identity check on a separately checked endpoint", async () => {
    const wrong = await endpoint(async (request) => {
      await pause(10);
      return request.method === "eth_chainId" ? "0x2" : standard(request);
    });
    const healthy = await endpoint(async (request) => {
      await pause(10);
      return standard(request);
    });
    const observer = createViemObserver({
      chains: { 1: { rpcUrls: [wrong.url, healthy.url] } },
      retry: { attempts: 2 },
    });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        observer.readCode({ chainId: 1, address: ADDRESS, snapshot: SNAPSHOT }),
      ),
    );
    expect(wrong.requests.map(({ method }) => method)).toEqual(["eth_chainId"]);
    expect(healthy.requests.filter(({ method }) => method === "eth_chainId")).toHaveLength(1);
    expect(healthy.requests.filter(({ method }) => method === "eth_getCode")).toHaveLength(8);
  });

  it("never shares a pending earlier identity check with the final ancestry fence", async () => {
    let identityReads = 0;
    let release!: () => void;
    const pendingIdentity = new Promise<void>((resolve) => {
      release = resolve;
    });
    let concurrentRead: Promise<unknown> | undefined;
    const rpc = await endpoint(async (request) => {
      if (request.method === "eth_chainId") {
        identityReads++;
        if (identityReads === 2) {
          await pendingIdentity;
          return "0x1";
        }
        return identityReads > 2 ? "0x2" : "0x1";
      }
      if (request.method === "eth_getBlockByNumber") {
        concurrentRead = observer.readCode({ chainId: 1, address: ADDRESS, snapshot: SNAPSHOT });
        await vi.waitFor(() => expect(identityReads).toBe(2));
      }
      return standard(request);
    });
    const observer = createViemObserver({
      chains: { 1: { rpcUrls: [rpc.url] } },
      retry: { attempts: 1 },
    });
    try {
      await expect(
        observer.checkBlockAncestry({
          chainId: 1,
          ancestor: SNAPSHOT,
          descendant: SNAPSHOT,
        }),
      ).rejects.toMatchObject({ cause: { attempts: [{ category: "chain-mismatch" }] } });
      expect(identityReads).toBe(3);
    } finally {
      release();
    }
    expect(await concurrentRead).toBe("0x6000");
  });

  it.each(["wrong-height", "missing-parent"])(
    "fails over a %s canonical header",
    async (failure) => {
      const broken = await endpoint((request) =>
        request.method === "eth_getBlockByNumber"
          ? {
              number: failure === "wrong-height" ? "0x65" : "0x64",
              hash: HASH,
              ...(failure === "missing-parent" ? {} : { parentHash: PARENT }),
            }
          : standard(request),
      );
      const healthy = await endpoint();
      const observer = createViemObserver({
        chains: { 1: { rpcUrls: [broken.url, healthy.url] } },
      });
      await expect(
        observer.checkBlockAncestry({ chainId: 1, ancestor: SNAPSHOT, descendant: SNAPSHOT }),
      ).resolves.toBe(true);
      expect(broken.requests.filter((r) => r.method === "eth_getBlockByNumber")).toHaveLength(1);
      expect(healthy.requests.filter((r) => r.method === "eth_getBlockByNumber")).toHaveLength(1);
    },
  );

  it("checks million-block-old pins with a bounded canonical read set", async () => {
    const rpc = await endpoint((request) => {
      if (request.method !== "eth_getBlockByNumber") return standard(request);
      return {
        number: request.params?.[0],
        hash: request.params?.[0] === "0x1" ? PARENT : HASH,
        parentHash: PARENT,
      };
    });
    const observer = createViemObserver({ chains: { 1: { rpcUrls: [rpc.url] } } });
    await expect(
      observer.checkBlockAncestry({
        chainId: 1,
        ancestor: { blockNumber: "1", blockHash: PARENT },
        descendant: { chainId: 1, blockNumber: "1000001", blockHash: HASH },
      }),
    ).resolves.toBe(true);
    expect(
      rpc.requests.filter((r) => r.method === "eth_getBlockByNumber").map((r) => r.params[0]),
    ).toEqual(["0xf4241", "0x1", "0xf4241"]);
    expect(rpc.requests.length).toBeLessThanOrEqual(7);
  });

  it.each(["ancestor", "descendant", "rebound-descendant", "adjacent-parent", "same-height"])(
    "rejects a contradictory %s pin",
    async (failure) => {
      let descendantReads = 0;
      const rpc = await endpoint((request) => {
        if (request.method !== "eth_getBlockByNumber") return standard(request);
        const isAncestor = request.params?.[0] === "0x63";
        if (!isAncestor) descendantReads++;
        return {
          number: request.params?.[0],
          hash: isAncestor
            ? failure === "ancestor"
              ? HASH
              : PARENT
            : failure === "descendant" ||
                failure === "same-height" ||
                (failure === "rebound-descendant" && descendantReads === 2)
              ? PARENT
              : HASH,
          parentHash: failure === "adjacent-parent" ? HASH : PARENT,
        };
      });
      const observer = createViemObserver({ chains: { 1: { rpcUrls: [rpc.url] } } });
      await expect(
        observer.checkBlockAncestry({
          chainId: 1,
          ancestor: failure === "same-height" ? SNAPSHOT : { blockNumber: "99", blockHash: PARENT },
          descendant: SNAPSHOT,
        }),
      ).resolves.toBe(false);
    },
  );

  it("rejects a chain switch after the final canonical block read", async () => {
    let blocks = 0;
    const rpc = await endpoint((request) => {
      if (request.method === "eth_chainId") return blocks === 3 ? "0x2" : "0x1";
      if (request.method === "eth_getBlockByNumber") {
        blocks++;
        return {
          number: request.params?.[0],
          hash: request.params?.[0] === "0x63" ? PARENT : HASH,
          parentHash: PARENT,
        };
      }
      return standard(request);
    });
    const observer = createViemObserver({
      chains: { 1: { rpcUrls: [rpc.url] } },
      retry: { attempts: 1 },
    });
    await expect(
      observer.checkBlockAncestry({
        chainId: 1,
        ancestor: { blockNumber: "99", blockHash: PARENT },
        descendant: SNAPSHOT,
      }),
    ).rejects.toMatchObject({
      code: "observation_failed",
      cause: { attempts: [{ category: "chain-mismatch" }] },
    });
  });

  it("aborts before accepting canonical ancestry", async () => {
    const controller = new AbortController();
    const rpc = await endpoint((request) => {
      if (request.method === "eth_getBlockByNumber") controller.abort();
      return standard(request);
    });
    const observer = createViemObserver({ chains: { 1: { rpcUrls: [rpc.url] } } });
    await expect(
      observer.checkBlockAncestry({
        chainId: 1,
        ancestor: SNAPSHOT,
        descendant: SNAPSHOT,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "observation_aborted" });
  });

  it("shares a throttled endpoint cooldown with queued reads and keeps their pins", async () => {
    const times: number[] = [];
    const rpc = await endpoint((request) => {
      if (request.method !== "eth_call") return standard(request);
      times.push(Date.now());
      return times.length === 1
        ? { error: { code: -32017, message: "rate limit private details" } }
        : "0x01";
    });
    const observer = createViemObserver({
      chains: { 1: { rpcUrls: [rpc.url] } },
      concurrency: 1,
      retry: { attempts: 1, rateLimitDelayMs: 50 },
    });
    const request = {
      chainId: 1,
      snapshot: SNAPSHOT,
      target: ADDRESS,
      data: "0x12345678",
      caller: ADDRESS,
    } as const;
    const results = await Promise.allSettled([
      observer.readCall(request),
      observer.readCall(request),
    ]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { cause: { attempts: [{ category: "rate-limited", rpcCode: -32017 }] } },
    });
    expect(results[1]).toEqual({ status: "fulfilled", value: "0x01" });
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(40);
    const calls = rpc.requests.filter((r) => r.method === "eth_call");
    expect(calls[0]).toEqual(calls[1]);
  });

  it("cancels an endpoint cooldown before any further request", async () => {
    const rpc = await endpoint((request) =>
      request.method === "eth_call"
        ? { error: { code: -32017, message: "rate limit private details" } }
        : standard(request),
    );
    const observer = createViemObserver({
      chains: { 1: { rpcUrls: [rpc.url] } },
      retry: { attempts: 1, rateLimitDelayMs: 5000 },
    });
    const request = {
      chainId: 1,
      snapshot: SNAPSHOT,
      target: ADDRESS,
      data: "0x12345678",
      caller: ADDRESS,
    } as const;
    await expect(observer.readCall(request)).rejects.toMatchObject({ code: "observation_failed" });
    const before = rpc.requests.length;
    const controller = new AbortController();
    const pending = observer.readCall({ ...request, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "observation_aborted",
      cause: null,
    });
    await pause(10);
    controller.abort("private abort reason");
    await rejected;
    expect(rpc.requests).toHaveLength(before);
  });

  it.each([
    [502, "http-5xx"],
    [429, "rate-limited"],
    [200, "non-json"],
    [-32000, "state-unavailable"],
    [-32602, "state-unavailable"],
    [-32603, "state-unavailable"],
    [-32001, "rate-limited"],
    [-32007, "rate-limited"],
  ] as const)(
    "fails over %s without changing the caller or pinned hash",
    async (failure, category) => {
      const broken = await endpoint((rpc, response) => {
        if (rpc.method !== "eth_call") return standard(rpc);
        if (failure > 0) {
          response.writeHead(failure, { "content-type": "text/html" });
          response.end("secret proxy response");
          return null;
        }
        return {
          error: {
            code: failure,
            message:
              failure === -32602
                ? "Archive requests require a personal token secret"
                : failure === -32603
                  ? "Internal error"
                  : failure === -32001
                    ? "usage limit secret"
                    : failure === -32007
                      ? "15/second request limit reached secret"
                      : "missing trie node secret",
          },
        };
      });
      const healthy = await endpoint();
      const observer = createViemObserver({
        chains: { 1: { rpcUrls: [broken.url, healthy.url] } },
        retry: { attempts: 2 },
      });
      expect(
        await observer.readCall({
          chainId: 1,
          snapshot: SNAPSHOT,
          target: ADDRESS,
          data: "0x12345678",
          caller: ADDRESS,
        }),
      ).toBe("0x");
      const reads = [...broken.requests, ...healthy.requests].filter(
        ({ method }) => method === "eth_call",
      );
      expect(reads).toHaveLength(2);
      expect(reads[0]).toEqual(reads[1]);
      expect(reads[0]!.params).toEqual([
        { from: ADDRESS, to: ADDRESS, data: "0x12345678" },
        { blockHash: HASH, requireCanonical: true },
      ]);
      const failing = createViemObserver({
        chains: { 1: { rpcUrls: [`${broken.url}/secret-token?key=secret`] } },
        retry: { attempts: 2 },
      });
      const error = await failing
        .readCall({
          chainId: 1,
          snapshot: SNAPSHOT,
          target: ADDRESS,
          data: "0x12345678",
          caller: ADDRESS,
        })
        .catch((error) => error);
      expect(error).toMatchObject({
        code: "observation_failed",
        cause: {
          attempts: [
            { category, endpoint: 0 },
            { category, endpoint: 0 },
          ],
        },
      });
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(String(error)).not.toContain(broken.url);
    },
  );

  it("blocks the wrong chain before reading and never retries a revert as chain state", async () => {
    const wrong = await endpoint((rpc) => (rpc.method === "eth_chainId" ? "0x2" : standard(rpc)));
    const healthy = await endpoint();
    const observer = createViemObserver({ chains: { 1: { rpcUrls: [wrong.url, healthy.url] } } });
    expect(await observer.readCode({ chainId: 1, address: ADDRESS, snapshot: SNAPSHOT })).toBe(
      "0x6000",
    );
    expect(wrong.requests.map(({ method }) => method)).toEqual(["eth_chainId"]);
    const reverter = await endpoint((rpc) =>
      rpc.method === "eth_call"
        ? { error: { code: 3, message: "execution reverted: secret" } }
        : standard(rpc),
    );
    const terminal = createViemObserver({
      chains: { 1: { rpcUrls: [reverter.url, healthy.url] } },
    });
    await expect(
      terminal.readCall({
        chainId: 1,
        snapshot: SNAPSHOT,
        target: ADDRESS,
        caller: ADDRESS,
        data: "0x12345678",
      }),
    ).rejects.toMatchObject({ cause: { attempts: [{ category: "reverted" }] } });
    expect(reverter.requests.filter(({ method }) => method === "eth_call")).toHaveLength(1);
    expect(healthy.requests.some(({ method }) => method === "eth_call")).toBe(false);
  });

  it("pins the requested lag and captures later chains immediately before reading", async () => {
    const rpc = await endpoint();
    const observer = createViemObserver({
      chains: { 1: { rpcUrls: [rpc.url], pin: { lagBlocks: 20 } } },
    });
    expect(await observer.captureSnapshot(1)).toEqual({ blockNumber: "80", blockHash: HASH });
    expect(
      rpc.requests
        .filter(({ method }) => method === "eth_getBlockByNumber")
        .map(({ params }) => params[0]),
    ).toEqual(["latest", "0x50"]);
    const order: string[] = [];
    const client = createMoesi({
      observer: {
        async captureSnapshot(id) {
          order.push(`pin-${id}`);
          return { blockNumber: "100", blockHash: HASH };
        },
        async readCode({ chainId }) {
          order.push(`read-${chainId}`);
          return "0x6000";
        },
        async readCall() {
          return "0x";
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    });
    await client.plan({ chains: [1, 2], manifest: manifest() });
    expect(order).toEqual(["pin-1", "read-1", "pin-2", "read-2"]);
  });

  it("keeps safe causes on serialized plans, verification, and snapshot errors", async () => {
    let failSnapshot = false;
    const rpc = await endpoint((request) =>
      request.method === "eth_getCode" ||
      (failSnapshot && request.method === "eth_getBlockByNumber")
        ? { error: { code: -32000, message: "missing trie node secret" } }
        : standard(request),
    );
    const client = createMoesi({
      observer: createViemObserver({
        chains: { 1: { rpcUrls: [rpc.url] } },
        retry: { attempts: 1 },
      }),
    });
    const plan = await client.plan({ chains: [1], manifest: manifest() });
    expect(plan.cells[0]!.status).toMatchObject({
      kind: "unreadable",
      cause: { attempts: [{ endpoint: 0, category: "state-unavailable", rpcCode: -32000 }] },
    });
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect((await client.verify({ plan })).chains[0]!.cells[0]!.status).toMatchObject({
      kind: "unreadable",
      cause: plan.cells[0]!.status.kind === "unreadable" ? plan.cells[0]!.status.cause : null,
    });
    failSnapshot = true;
    await expect(client.plan({ chains: [1], manifest: manifest() })).rejects.toMatchObject({
      code: "snapshot_unreadable",
      cause: { attempts: [{ category: "state-unavailable" }] },
    });
    expect(JSON.stringify(await client.verify({ plan }))).not.toContain("secret");
    expect((await client.verify({ plan })).chains[0]!.cells[0]!.status).toMatchObject({
      reason: "snapshot-unreadable",
      cause: { attempts: [{ category: "state-unavailable" }] },
    });
  });

  it("bounds concurrency and batches independent reads without changing the caller", async () => {
    let active = 0;
    let peak = 0;
    const rpc = await endpoint(async (request) => {
      if (request.method === "eth_call") {
        peak = Math.max(peak, ++active);
        await pause(5);
        active--;
        return "0x01";
      }
      return standard(request);
    });
    const client = createMoesi({
      observer: createViemObserver({
        chains: { 1: { rpcUrls: [rpc.url] } },
        concurrency: 3,
        batch: true,
      }),
    });
    const plan = await client.plan({ chains: [1], manifest: manifest(20) });
    expect(plan.disposition).toBe("converged");
    expect(Math.max(...rpc.batches)).toBe(3);
    expect(peak).toBeLessThanOrEqual(3);
    const calls = rpc.requests.filter(({ method }) => method === "eth_call");
    expect(calls).toHaveLength(20);
    for (const call of calls) expect(call.params[0]).toMatchObject({ from: ADDRESS, to: ADDRESS });
  });

  it("enforces one transport limit across concurrent resources and their nested checks", async () => {
    let active = 0;
    let peak = 0;
    const rpc = await endpoint(async (request) => {
      peak = Math.max(peak, ++active);
      try {
        await pause(5);
        return request.method === "eth_call" ? "0x01" : standard(request);
      } finally {
        active--;
      }
    });
    const input: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: Array.from({ length: 4 }, (_, index) => ({
        ...manifest(4).contracts[0]!,
        id: `resource-${index}`,
        address: `0x${(index + 1).toString(16).padStart(40, "0")}` as const,
      })),
    };
    const client = createMoesi({
      observer: createViemObserver({
        chains: { 1: { rpcUrls: [rpc.url] } },
        concurrency: 3,
      }),
    });
    const plan = await client.plan({ manifest: input, chains: [1] });
    expect(plan.disposition).toBe("converged");
    expect((await client.verify({ plan })).chains[0]?.status).toBe("converged");
    expect(rpc.requests.filter(({ method }) => method === "eth_call")).toHaveLength(32);
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it("times out endpoints and propagates cancellation without retaining the abort reason", async () => {
    const slow = await endpoint(async (rpc) => {
      await pause(100);
      return standard(rpc);
    });
    const healthy = await endpoint();
    const observer = createViemObserver({
      chains: { 1: { rpcUrls: [slow.url, healthy.url] } },
      timeoutMs: 20,
    });
    expect(await observer.readCode({ chainId: 1, address: ADDRESS, snapshot: SNAPSHOT })).toBe(
      "0x6000",
    );
    const controller = new AbortController();
    const pendingObserver = createViemObserver({
      chains: { 1: { rpcUrls: [slow.url] } },
      concurrency: 1,
    });
    const client = createMoesi({ observer: pendingObserver });
    await expect(
      client.plan({ chains: [1], manifest: manifest(), signal: {} as AbortSignal }),
    ).rejects.toMatchObject({ code: "invalid_observer_configuration" });
    const pending = client.plan({ chains: [1], manifest: manifest(), signal: controller.signal });
    controller.abort(new Error("secret abort reason"));
    const error = await pending.catch((error) => error);
    expect(error).toMatchObject({ code: "observation_aborted", cause: null });
    expect(JSON.stringify(error)).not.toContain("secret");
    const independent = await createMoesi({ observer }).plan({ chains: [1], manifest: manifest() });
    await expect(
      client.verify({ plan: independent, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "observation_aborted" });
  });

  it("rejects malformed configuration and diagnostic accessors before running them", () => {
    for (const config of [
      null,
      {},
      { chains: {} },
      { chains: { 1: { rpcUrls: [] } } },
      { chains: { 1: { rpcUrls: ["file:///secret"] } } },
      { chains: { 1: { rpcUrls: ["http://127.0.0.1"], pin: "pending" } } },
      { chains: { 1: { rpcUrls: ["http://127.0.0.1"] } }, retry: { attempts: 0 } },
    ])
      expect(() => createViemObserver(config as never)).toThrowError(
        expect.objectContaining({ code: "invalid_observer_configuration" }),
      );
    const getter = vi.fn();
    expect(() =>
      createViemObserver(Object.defineProperty({}, "chains", { get: getter }) as never),
    ).toThrow(MoesiObservationError);
    expect(() =>
      parseObservationCause({ attempts: [Object.defineProperty({}, "category", { get: getter })] }),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("cancels queued and active reads without starving later requests", async () => {
    let slow = true;
    const rpc = await endpoint(async (request) => {
      if (slow) await pause(150);
      return standard(request);
    });
    const observer = createViemObserver({ chains: { 1: { rpcUrls: [rpc.url] } }, concurrency: 1 });
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const read = (signal?: AbortSignal) =>
      observer.readCode({
        chainId: 1,
        snapshot: SNAPSHOT,
        address: ADDRESS,
        ...(signal ? { signal } : {}),
      });
    const first = read(firstController.signal).catch((error) => error);
    await vi.waitFor(() => expect(rpc.requests.length).toBe(1));
    const queued = read(queuedController.signal).catch((error) => error);
    queuedController.abort();
    expect(await queued).toMatchObject({ code: "observation_aborted" });
    firstController.abort();
    expect(await first).toMatchObject({ code: "observation_aborted" });
    slow = false;
    expect(await read(AbortSignal.timeout(1000))).toBe("0x6000");
  });

  it("bounds failed attempts, reports timeouts, and treats authentication failures as terminal", async () => {
    const slow = await endpoint(async (request) => {
      await pause(100);
      return standard(request);
    });
    const timed = createViemObserver({
      chains: { 1: { rpcUrls: [slow.url] } },
      timeoutMs: 10,
      retry: { attempts: 1 },
    });
    await expect(timed.captureSnapshot(1)).rejects.toMatchObject({
      cause: { attempts: [{ category: "timeout", endpoint: 0 }] },
    });
    const unauthorized = await endpoint((_request, response) => {
      response.writeHead(401);
      response.end("secret denied");
    });
    const blocked = createViemObserver({
      chains: { 1: { rpcUrls: [unauthorized.url] } },
      retry: { attempts: 3 },
    });
    await expect(blocked.captureSnapshot(1)).rejects.toMatchObject({
      cause: { attempts: [{ category: "http-error", httpStatus: 401 }] },
    });
    expect(unauthorized.requests).toHaveLength(1);
  });

  it("rejects mismatched RPC response IDs and times out a stalled response body", async () => {
    const mismatched = await endpoint((rpc, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id + 1, result: "0x1" }));
    });
    const invalid = createViemObserver({
      chains: { 1: { rpcUrls: [mismatched.url] } },
      retry: { attempts: 1 },
    });
    await expect(invalid.captureSnapshot(1)).rejects.toMatchObject({
      cause: { attempts: [{ category: "invalid-response" }] },
    });
    const stalled = await endpoint(async (_rpc, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"jsonrpc":');
      await pause(150);
      if (!response.destroyed) response.end('"2.0"}');
    });
    const bounded = createViemObserver({
      chains: { 1: { rpcUrls: [stalled.url] } },
      timeoutMs: 20,
      retry: { attempts: 1 },
    });
    await expect(bounded.captureSnapshot(1)).rejects.toMatchObject({
      cause: { attempts: [{ category: "timeout" }] },
    });
  });

  it("preserves call diagnostics and rejects edited cause payloads and stale plans", async () => {
    const rpc = await endpoint((request) =>
      request.method === "eth_call"
        ? { error: { code: -32001, message: "usage limit secret" } }
        : standard(request),
    );
    const client = createMoesi({
      observer: createViemObserver({
        chains: { 1: { rpcUrls: [rpc.url] } },
        retry: { attempts: 1 },
        batch: true,
      }),
    });
    const plan = await client.plan({ manifest: manifest(2), chains: [1] });
    expect(plan.cells[0]!.status).toMatchObject({
      source: "call-check",
      id: "check-0",
      cause: { attempts: [{ category: "rate-limited" }] },
    });
    const result = await client.verify({ plan });
    expect(result.chains[0]!.cells[0]!.status).toMatchObject({
      reason: "call-read-failed",
      cause: { attempts: [{ category: "rate-limited" }] },
    });
    expect(result.chains[0]!.cells[0]!.callChecks[0]!.status).toMatchObject({
      cause: { attempts: [{ category: "rate-limited" }] },
    });
    const edited = JSON.parse(JSON.stringify(plan));
    edited.cells[0].status.cause.attempts[0].message = "secret";
    expect(() => parseReviewedPlan(edited)).toThrowError(
      expect.objectContaining({ code: "invalid_cell" }),
    );
    expect(() =>
      parseReviewedPlan({ ...plan, version: "moesi.reviewed-plan/v5" } as never),
    ).toThrowError(expect.objectContaining({ code: "unsupported_plan_version" }));
  });
});
