import {
  createPublicClient,
  createRpcWalletClient,
  createWalletClient,
  custom,
  defineChain,
} from "cetane";
import { privateKeyToAccount } from "cetane/accounts/privateKeyToAccount";
import { createExecution } from "cetane/execution/evm";
import type { ProbeClient } from "moesi";
import {
  type CetanePublicClientLike,
  type CetaneWalletClientLike,
  createCetaneExecutionProvider,
  createCetaneObservationAdapter,
  createCetaneObserver,
} from "moesi/cetane";

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error("cetane_consumer_assertion_failed");
}

const chain = defineChain({
  id: 1,
  name: "Local fixture",
  nativeAA: false,
  execution: createExecution(),
});
const transport = custom({
  async request() {
    throw new Error("unexpected_rpc");
  },
});
// Public deterministic fixture key, never a user credential.
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const reader = createPublicClient({ chain, transport });
const local = createWalletClient({
  chain,
  transport,
  account: { address: signer.address },
  signer,
});
const remote = createRpcWalletClient({ chain, transport, account: signer.address });
const typedReader: CetanePublicClientLike = reader;
const probe: ProbeClient = reader;
const wallets: CetaneWalletClientLike[] = [local, remote];
for (const wallet of wallets) {
  const provider = createCetaneExecutionProvider({
    walletClientForChain: () => wallet,
    publicClientForChain: () => typedReader,
    confirmations: 1,
  });
  equal(provider.id, "cetane");
}
equal(
  typeof createCetaneObservationAdapter({ publicClientForChain: () => reader }).readCode,
  "function",
);
equal(typeof probe.call, "function");
console.log("packed Cetane clients: local and RPC wallets, observation and probe types verified");

for (const pin of ["safe", "finalized"] as const) {
  equal(
    typeof createCetaneObserver({ chains: { 1: { rpcUrls: ["http://127.0.0.1:1"], pin } } })
      .captureSnapshot,
    "function",
  );
}
