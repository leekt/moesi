import type { MoesiObservationAdapter } from "moesi";
import { createViemObserver } from "moesi/viem";

export interface RpcChainBinding {
  readonly chainId: number;
  readonly url: string;
}

export type CliFetch = typeof globalThis.fetch;

export function createRpcObservationAdapter(
  bindings: readonly RpcChainBinding[],
  fetcher: CliFetch,
): MoesiObservationAdapter {
  return createViemObserver({
    chains: Object.fromEntries(bindings.map(({ chainId, url }) => [chainId, { rpcUrls: [url] }])),
    fetchFn: fetcher,
  });
}
