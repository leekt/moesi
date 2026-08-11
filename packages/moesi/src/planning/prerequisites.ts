import { deriveManagedDeploymentOrder } from "../manifest/runtime-prerequisites.js";
import type { ContractResource, ManagedContractResource } from "../manifest/types.js";
import { deploymentCapabilitySpec } from "./resource.js";
import type { DeploymentCapability, ResourceCell } from "./types.js";

/**
 * Resolves the missing managed resources whose deployment-time runtime
 * prerequisites can be satisfied on one pinned chain. The returned ids are in
 * the manifest's canonical managed deployment order, so every recursively
 * deployable prerequisite precedes its dependent.
 */
export function deriveActionableMissingManagedResourceIds(input: {
  readonly contracts: readonly ContractResource[];
  readonly cells: readonly ResourceCell[];
  readonly capabilities: readonly DeploymentCapability[];
}): readonly string[] {
  const resourcesById = new Map(
    input.contracts.map((resource) => [resource.id, resource] as const),
  );
  const cellsById = new Map(input.cells.map((cell) => [cell.resourceId, cell] as const));
  const availableDeploymentKinds = new Set(
    input.capabilities.filter(({ status }) => status.kind === "available").map(({ kind }) => kind),
  );
  const deployable = new Map<string, boolean>();
  const resolving = new Set<string>();

  const runtimeWillExist = (resourceId: string): boolean => {
    const resource = resourcesById.get(resourceId);
    const cell = cellsById.get(resourceId);
    if (resource === undefined || cell === undefined) return false;
    if (runtimeIsExact(cell)) return true;
    if (cell.status.kind !== "missing" || resource.kind !== "managed") return false;
    return missingManagedIsDeployable(resource);
  };

  const missingManagedIsDeployable = (resource: ManagedContractResource): boolean => {
    const memoized = deployable.get(resource.id);
    if (memoized !== undefined) return memoized;
    const cell = cellsById.get(resource.id);
    if (cell?.status.kind !== "missing" || resolving.has(resource.id)) {
      deployable.set(resource.id, false);
      return false;
    }
    if (!availableDeploymentKinds.has(deploymentCapabilitySpec(resource.deployment).kind)) {
      deployable.set(resource.id, false);
      return false;
    }
    resolving.add(resource.id);
    const actionable = resource.deployment.requiresRuntime.every(runtimeWillExist);
    resolving.delete(resource.id);
    deployable.set(resource.id, actionable);
    return actionable;
  };

  return Object.freeze(
    deriveManagedDeploymentOrder(input.contracts).filter((resourceId) => {
      const resource = resourcesById.get(resourceId);
      return resource?.kind === "managed" && missingManagedIsDeployable(resource);
    }),
  );
}

/** Runtime prerequisites depend only on exact runtime evidence, not semantic convergence. */
function runtimeIsExact(cell: ResourceCell): boolean {
  return (
    cell.status.kind === "converged" ||
    cell.status.kind === "drift" ||
    (cell.status.kind === "unreadable" && cell.status.source !== "runtime-code")
  );
}
