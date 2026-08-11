import type { MoesiObservationAdapter } from "moesi";

export interface RpcChainBinding {
  readonly chainId: number;
  readonly url: string;
}

export type CliFetch = typeof globalThis.fetch;

const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_ANCESTRY_DEPTH = 4_096n;

export function createRpcObservationAdapter(
  bindings: readonly RpcChainBinding[],
  fetcher: CliFetch,
): MoesiObservationAdapter {
  const urls = new Map(bindings.map(({ chainId, url }) => [chainId, url]));
  let nextId = 1;

  async function request(
    chainId: number,
    method: string,
    params: readonly unknown[],
  ): Promise<unknown> {
    const url = urls.get(chainId);
    if (!url) throw new Error("chain is not configured");
    const id = nextId++;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch {
      throw new Error("rpc request failed");
    }
    if (!response.ok) throw new Error("rpc request failed");
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("rpc response is invalid");
    }
    const record = plainRecord(value);
    if (record === null) throw new Error("rpc response is invalid");
    if (
      record.jsonrpc !== "2.0" ||
      record.id !== id ||
      "error" in record ||
      !("result" in record)
    ) {
      throw new Error("rpc response is invalid");
    }
    return record.result;
  }

  async function assertChainIdentity(chainId: number): Promise<void> {
    const value = await request(chainId, "eth_chainId", []);
    if (typeof value !== "string" || !QUANTITY.test(value) || BigInt(value) !== BigInt(chainId)) {
      throw new Error("RPC chain identity is unavailable or contradictory");
    }
  }

  return {
    async captureSnapshot(chainId) {
      await assertChainIdentity(chainId);
      const value = await request(chainId, "eth_getBlockByNumber", ["latest", false]);
      const block = plainRecord(value);
      if (block === null) throw new Error("block response is invalid");
      if (typeof block.number !== "string" || !QUANTITY.test(block.number)) {
        throw new Error("block number is invalid");
      }
      if (typeof block.hash !== "string" || !HASH.test(block.hash)) {
        throw new Error("block hash is invalid");
      }
      return {
        blockNumber: BigInt(block.number).toString(10),
        blockHash: block.hash.toLowerCase() as `0x${string}`,
      };
    },
    async readCode({ chainId, address, snapshot }) {
      return request(chainId, "eth_getCode", [
        address,
        { blockHash: snapshot.blockHash, requireCanonical: true },
      ]);
    },
    async readCall({ chainId, target, data, caller, snapshot }) {
      return request(chainId, "eth_call", [
        { from: caller, to: target, data },
        { blockHash: snapshot.blockHash, requireCanonical: true },
      ]);
    },
    async readStorage({ chainId, address, slot, snapshot }) {
      return request(chainId, "eth_getStorageAt", [
        address,
        slot,
        { blockHash: snapshot.blockHash, requireCanonical: true },
      ]);
    },
    async checkBlockAncestry({ chainId, ancestor, descendant }) {
      await assertChainIdentity(chainId);
      const ancestorNumber = BigInt(ancestor.blockNumber);
      const descendantNumber = BigInt(descendant.blockNumber);
      if (ancestorNumber > descendantNumber) return false;
      if (descendantNumber - ancestorNumber > MAX_ANCESTRY_DEPTH) {
        throw new Error("block ancestry depth exceeds the observation bound");
      }
      let currentNumber = descendantNumber;
      let currentHash = descendant.blockHash;
      while (currentNumber > ancestorNumber) {
        const value = await request(chainId, "eth_getBlockByHash", [currentHash, false]);
        const block = plainRecord(value);
        if (block === null) throw new Error("block response is invalid");
        if (
          typeof block.number !== "string" ||
          !QUANTITY.test(block.number) ||
          BigInt(block.number) !== currentNumber ||
          typeof block.hash !== "string" ||
          !HASH.test(block.hash) ||
          block.hash.toLowerCase() !== currentHash ||
          typeof block.parentHash !== "string" ||
          !HASH.test(block.parentHash)
        ) {
          throw new Error("block response is invalid");
        }
        currentNumber -= 1n;
        currentHash = block.parentHash.toLowerCase() as `0x${string}`;
      }
      return currentHash === ancestor.blockHash;
    },
  };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) snapshot[key] = Reflect.get(value, key);
    return snapshot;
  } catch {
    return null;
  }
}
