import { createOAAthExecutionProvider, requestOAAthPlanPermission } from "@moesi/oaath";
import { createMoesi, MemoryDeploymentRunStore } from "moesi";
import { createCetaneObservationAdapter } from "moesi/cetane";
import { manifest } from "../shared/manifest.mjs";

/** The application supplies a configured public OAAth SDK instance and a read-only viem client. */
export async function run({ oaath, publicClient }) {
  const chainId = publicClient.chain.id;
  const moesi = createMoesi({
    observer: createCetaneObservationAdapter({
      publicClientForChain: (id) => (id === chainId ? publicClient : undefined),
    }),
    runStore: new MemoryDeploymentRunStore(),
  });
  const plan = await moesi.plan({ manifest, chains: [chainId] });
  // Consent is a separate explicit action. Provider review itself never authorizes or sends.
  const authorization = await requestOAAthPlanPermission({ oaath, plans: [plan] });
  const provider = createOAAthExecutionProvider({ oaath });
  const executionReview = await moesi.reviewExecution({ plan, provider });
  if (executionReview.provider.status !== "supported") throw new Error("example_provider_blocked");
  // Local fixture acceptance; applications present this exact provider-bound review.
  const result = await moesi.apply({ plan, provider, executionReview }).wait();
  const verification = await moesi.verify({ plan });
  return { plan, authorization, executionReview, result, verification };
}
