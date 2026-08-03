import type { MoesiObservationAdapter } from "moesi";

export interface RpcChainBinding {
  readonly chainId: number;
  readonly url: string;
}

export type CliFetch = typeof globalThis.fetch;

const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

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
    if (!isPlainRecord(value)) throw new Error("rpc response is invalid");
    if (value.jsonrpc !== "2.0" || value.id !== id || "error" in value || !("result" in value)) {
      throw new Error("rpc response is invalid");
    }
    return value.result;
  }

  return {
    async captureSnapshot(chainId) {
      const value = await request(chainId, "eth_getBlockByNumber", ["latest", false]);
      if (!isPlainRecord(value)) throw new Error("block response is invalid");
      if (typeof value.number !== "string" || !QUANTITY.test(value.number)) {
        throw new Error("block number is invalid");
      }
      if (typeof value.hash !== "string" || !HASH.test(value.hash)) {
        throw new Error("block hash is invalid");
      }
      return {
        blockNumber: BigInt(value.number),
        blockHash: value.hash.toLowerCase() as `0x${string}`,
      };
    },
    async readCode({ chainId, address, snapshot }) {
      return request(chainId, "eth_getCode", [
        address,
        { blockHash: snapshot.blockHash, requireCanonical: true },
      ]);
    },
    async readCall({ chainId, target, data, snapshot }) {
      return request(chainId, "eth_call", [
        { to: target, data },
        { blockHash: snapshot.blockHash, requireCanonical: true },
      ]);
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
