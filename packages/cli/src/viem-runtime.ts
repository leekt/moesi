import type { MoesiExecutionProvider, MoesiObservationAdapter } from "moesi";
import {
  createHttpTransport,
  createViemExecutionProvider,
  createViemObserver,
  rpcEndpoint,
  type ViemPublicClientLike,
  type ViemWalletClientLike,
} from "moesi/viem";
import { createPublicClient, createWalletClient, defineChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CliError } from "./errors.js";
import type { RpcChainBinding } from "./rpc.js";

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface CreateCliViemRuntimeInput {
  readonly chains: readonly RpcChainBinding[];
  readonly privateKeys: ReadonlyMap<number, string>;
  readonly confirmations: number;
}

export interface CliViemRuntime {
  readonly observer: MoesiObservationAdapter;
  readonly provider: MoesiExecutionProvider;
}

export type CliViemRuntimeFactory = (input: CreateCliViemRuntimeInput) => CliViemRuntime;

/**
 * Builds the one supported CLI execution route from exact chain bindings and
 * environment-sourced local accounts. HTTP retries are disabled so transport
 * behavior cannot repeat an ambiguous submission behind the durable fence, and
 * transport failures are scrubbed of URLs, credentials and signed payloads.
 */
export function createCliViemRuntime(input: CreateCliViemRuntimeInput): CliViemRuntime {
  const readers = new Map<number, ViemPublicClientLike>();
  const wallets = new Map<number, ViemWalletClientLike>();

  for (const binding of input.chains) {
    const chain = defineChain({
      id: binding.chainId,
      name: `Moesi chain ${binding.chainId}`,
      nativeCurrency: { name: "Native token", symbol: "NATIVE", decimals: 18 },
      // Chain metadata never carries URL userinfo; the transport sends it as a header.
      rpcUrls: { default: { http: [rpcEndpoint(binding.url).url] } },
    });
    const transport = createHttpTransport(binding.url, {
      retryCount: 0,
      timeout: 30_000,
      fetchOptions: { redirect: "error" },
    });
    readers.set(
      binding.chainId,
      createPublicClient({ chain, transport }) as unknown as ViemPublicClientLike,
    );

    const privateKey = input.privateKeys.get(binding.chainId);
    if (privateKey === undefined) continue;
    if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
      throw new CliError("signer_invalid", "signer private key is invalid");
    }
    let account: ReturnType<typeof privateKeyToAccount>;
    try {
      account = privateKeyToAccount(privateKey as Hex);
    } catch {
      throw new CliError("signer_invalid", "signer private key is invalid");
    }
    wallets.set(
      binding.chainId,
      createWalletClient({ chain, account, transport }) as unknown as ViemWalletClientLike,
    );
  }

  const publicClientForChain = (chainId: number): ViemPublicClientLike | undefined =>
    readers.get(chainId);
  return Object.freeze({
    observer: createViemObserver({
      chains: Object.fromEntries(
        input.chains.map(({ chainId, url }) => [chainId, { rpcUrls: [url] }]),
      ),
    }),
    provider: createViemExecutionProvider({
      publicClientForChain,
      walletClientForChain: (chainId) => wallets.get(chainId),
      confirmations: input.confirmations,
    }),
  });
}
