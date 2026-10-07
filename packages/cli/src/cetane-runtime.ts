import { createPublicClient, createWalletClient, defineChain, type Hex } from "cetane";
import { privateKeyToAccount } from "cetane/accounts/privateKeyToAccount";
import { createExecution } from "cetane/execution/evm";
import type { MoesiExecutionProvider, MoesiObservationAdapter } from "moesi";
import {
  type CetanePublicClientLike,
  type CetaneWalletClientLike,
  createCetaneExecutionProvider,
  createCetaneObserver,
  createHttpTransport,
  rpcEndpoint,
} from "moesi/cetane";
import { CliError } from "./errors.js";
import type { RpcChainBinding } from "./rpc.js";

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface CreateCliCetaneRuntimeInput {
  readonly chains: readonly RpcChainBinding[];
  readonly privateKeys: ReadonlyMap<number, string>;
  readonly confirmations: number;
}

export interface CliCetaneRuntime {
  readonly observer: MoesiObservationAdapter;
  readonly provider: MoesiExecutionProvider;
}

export type CliCetaneRuntimeFactory = (input: CreateCliCetaneRuntimeInput) => CliCetaneRuntime;

/**
 * Builds the one supported CLI execution route from exact chain bindings and
 * environment-sourced local accounts. HTTP retries are disabled so transport
 * behavior cannot repeat an ambiguous submission behind the durable fence, and
 * transport failures are scrubbed of URLs, credentials and signed payloads.
 */
export function createCliCetaneRuntime(input: CreateCliCetaneRuntimeInput): CliCetaneRuntime {
  const readers = new Map<number, CetanePublicClientLike>();
  const wallets = new Map<number, CetaneWalletClientLike>();

  for (const binding of input.chains) {
    const chain = defineChain({
      nativeAA: false,
      execution: createExecution(),
      id: binding.chainId,
      name: `Moesi chain ${binding.chainId}`,
      nativeCurrency: { name: "Native token", symbol: "NATIVE", decimals: 18 },
      // Chain metadata never carries URL userinfo; the transport sends it as a header.
      rpcUrls: { default: { http: [rpcEndpoint(binding.url).url] } },
    });
    const transport = createHttpTransport(binding.url, {
      timeout: 30_000,
    });
    readers.set(binding.chainId, createPublicClient({ chain, transport }));

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
      createWalletClient({
        chain,
        account: { address: account.address },
        signer: account,
        transport,
      }),
    );
  }

  const publicClientForChain = (chainId: number): CetanePublicClientLike | undefined =>
    readers.get(chainId);
  return Object.freeze({
    observer: createCetaneObserver({
      chains: Object.fromEntries(
        input.chains.map(({ chainId, url }) => [chainId, { rpcUrls: [url] }]),
      ),
    }),
    provider: createCetaneExecutionProvider({
      publicClientForChain,
      walletClientForChain: (chainId) => wallets.get(chainId),
      confirmations: input.confirmations,
    }),
  });
}
