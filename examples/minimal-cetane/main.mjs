import { createMoesi, MemoryDeploymentRunStore } from "moesi";
import { createCetaneExecutionProvider, createCetaneObservationAdapter } from "moesi/cetane";
import { manifest } from "../shared/manifest.mjs";

/** The application supplies its ordinary Cetane clients; this module owns no wallet key. */
export async function run({ publicClient, walletClient }) {
  const chainId = publicClient.chain.id;
  const publicClientForChain = (id) => (id === chainId ? publicClient : undefined);
  const moesi = createMoesi({
    observer: createCetaneObservationAdapter({ publicClientForChain }),
    runStore: new MemoryDeploymentRunStore(),
  });
  const plan = await moesi.plan({ manifest, chains: [chainId] });
  const provider = createCetaneExecutionProvider({
    publicClientForChain,
    walletClientForChain: (id) => (id === chainId ? walletClient : undefined),
    confirmations: 1,
  });
  const executionReview = await moesi.reviewExecution({ plan, provider });
  if (executionReview.provider.status !== "supported") throw new Error("example_provider_blocked");
  // This local example accepts its known fixture plan here. An application presents this exact review before apply.
  const result = await moesi.apply({ plan, provider, executionReview }).wait();
  const verification = await moesi.verify({ plan });
  return { plan, executionReview, result, verification };
}
