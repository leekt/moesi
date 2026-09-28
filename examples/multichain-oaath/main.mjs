import { createOAAthExecutionProvider, requestOAAthPlanPermission } from "@moesi/oaath";
import { createMoesi, MemoryDeploymentRunStore } from "moesi";
import { createViemObservationAdapter } from "moesi/viem";
import { manifest } from "../shared/manifest.mjs";

/** publicClients is a Map<chainId, PublicClient>; one SDK instance supplies all-chain authority. */
export async function run({ oaath, publicClients }) {
  const moesi = createMoesi({
    observer: createViemObservationAdapter({ publicClientForChain: (id) => publicClients.get(id) }),
    runStore: new MemoryDeploymentRunStore(),
  });
  const plan = await moesi.plan({ manifest, chains: [...publicClients.keys()] });
  // One all-chain Grant request for the complete plan, outside the chain loop.
  const authorization = await requestOAAthPlanPermission({ oaath, plan });
  const provider = createOAAthExecutionProvider({ oaath });
  const executionReview = await moesi.reviewExecution({ plan, provider });
  if (executionReview.provider.status !== "supported") throw new Error("example_provider_blocked");
  const result = await moesi.apply({ plan, provider, executionReview }).wait();
  // Provider finality and Moesi deployment verification are separate evidence.
  const verification = await moesi.verify({ plan });
  return { plan, authorization, executionReview, result, verification };
}
