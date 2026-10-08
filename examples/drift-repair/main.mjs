import { encodeFunctionData, keccak256, padHex, parseAbi, toHex } from "cetane/utils";
import { createMoesi, MemoryDeploymentRunStore } from "moesi";
import { createCetaneExecutionProvider, createCetaneObservationAdapter } from "moesi/cetane";
import bytecode from "./bytecode.json" with { type: "json" };

const abi = parseAbi(["function value() view returns (uint256)", "function setValue(uint256)"]);

/** Deploy desired value 42, introduce an out-of-band change, then review its exact repair. */
export async function run({ publicClient, walletClient }) {
  const chainId = publicClient.chain.id;
  const publicClientForChain = (id) => (id === chainId ? publicClient : undefined);
  const moesi = createMoesi({
    observer: createCetaneObservationAdapter({ publicClientForChain }),
    runStore: new MemoryDeploymentRunStore(),
  });
  const provider = createCetaneExecutionProvider({
    publicClientForChain,
    walletClientForChain: (id) => (id === chainId ? walletClient : undefined),
    confirmations: 1,
  });
  const manifest = {
    version: "moesi.manifest/v8",
    contracts: [
      {
        kind: "managed",
        id: "configurable",
        deployment: {
          kind: "create2-factory-v1",
          salt: `0x${"cd".repeat(32)}`,
          initCode: bytecode.initCode,
          value: "0",
          requiresRuntime: [],
        },
        expectedRuntimeCodeHash: keccak256(bytecode.runtimeCode),
        checks: [],
        storageChecks: [],
        configuration: [
          {
            id: "value",
            readData: encodeFunctionData({ abi, functionName: "value" }),
            expectedResult: padHex(toHex(42), { size: 32 }),
            writeData: encodeFunctionData({ abi, functionName: "setValue", args: [42n] }),
            value: "0",
          },
        ],
      },
    ],
  };
  const initialPlan = await moesi.plan({ manifest, chains: [chainId] });
  const initialReview = await moesi.reviewExecution({ plan: initialPlan, provider });
  if (initialReview.provider.status !== "supported") throw new Error("example_provider_blocked");
  const initial = await moesi
    .apply({ plan: initialPlan, provider, executionReview: initialReview })
    .wait();
  if (initial.status !== "converged") throw new Error("example_initial_convergence_failed");
  const address = initialPlan.cells[0].address;
  // Simulate an external actor changing the permissionless demonstration contract.
  const changed = await walletClient.sendTransaction({
    to: address,
    data: encodeFunctionData({ abi, functionName: "setValue", args: [7n] }),
  });
  await publicClient.waitForTransactionReceipt({ hash: changed });
  const drift = await moesi.verify({ plan: initialPlan });
  const plan = await moesi.plan({ manifest, chains: [chainId] });
  if (drift.status !== "drifted" || plan.steps.length !== 1 || plan.steps[0].kind !== "configure")
    throw new Error("example_drift_not_observed");
  // This is a new plan and requires a new provider-bound review.
  const executionReview = await moesi.reviewExecution({ plan, provider });
  if (executionReview.provider.status !== "supported") throw new Error("example_provider_blocked");
  const result = await moesi.apply({ plan, provider, executionReview }).wait();
  const verification = await moesi.verify({ plan });
  return { initialPlan, initialReview, drift, plan, executionReview, result, verification };
}
