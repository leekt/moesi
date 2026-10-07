import type { ContractResource } from "../manifest/types.js";
import type { DeploymentStep, ResourceCell } from "../planning/types.js";
import { DEFAULT_PLAN_ENFORCEMENT } from "../planning/types.js";

/** Only explicitly reviewed self-call bytes for positive unexpected state can become steps. */
export function compileModuleRemovals(
  resource: ContractResource,
  cell: ResourceCell,
): DeploymentStep[] {
  const expectation = resource.accountModules;
  const evidence = cell.accountModules;
  if (
    !expectation?.accountId ||
    evidence?.kind !== "drifted" ||
    cell.status.kind !== "module-drift"
  )
    return [];
  const unexpected = new Set(
    evidence.differences.filter(({ kind }) => kind === "unexpected").map(({ key }) => key),
  );
  return (expectation.removals ?? [])
    .filter(({ key }) => unexpected.has(key))
    .map(({ key, data }) => ({
      id: `${resource.id}:remove-module:${key}`,
      resourceId: resource.id,
      chainId: cell.chainId,
      kind: "remove-module",
      configurationIds: [],
      drift: "account-module-drift",
      call: { target: cell.address, data, value: "0" },
      // Fresh convergence re-observes the whole module expectation after execution.
      postconditions: [
        {
          kind: "runtime-code-hash",
          address: cell.address,
          expectedHash: cell.expectedRuntimeCodeHash,
        },
      ],
      sender: {
        kind: "logical-smart-account",
        accountId: expectation.accountId!,
        address: cell.address,
      },
      enforcement:
        resource.kind === "managed"
          ? (resource.enforcement ?? DEFAULT_PLAN_ENFORCEMENT)
          : DEFAULT_PLAN_ENFORCEMENT,
    }));
}
