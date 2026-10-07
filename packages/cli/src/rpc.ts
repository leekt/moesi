import type { MoesiObservationAdapter } from "moesi";
import { createCetaneObserver } from "moesi/cetane";

export interface RpcChainBinding {
  readonly chainId: number;
  readonly url: string;
}

export type CliFetch = typeof globalThis.fetch;

export function createRpcObservationAdapter(
  bindings: readonly RpcChainBinding[],
  fetcher: CliFetch,
): MoesiObservationAdapter {
  return createCetaneObserver({
    chains: Object.fromEntries(bindings.map(({ chainId, url }) => [chainId, { rpcUrls: [url] }])),
    fetchFn: fetcher,
  });
}
