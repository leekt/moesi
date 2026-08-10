import { MoesiManifestError } from "../errors.js";
import { compareAscii } from "../internal.js";
import type { ContractResource } from "./types.js";

/**
 * Returns the lexicographically least valid deployment order for managed
 * resources. External prerequisites validate and satisfy graph edges but are
 * never included in the managed deployment order.
 */
export function deriveManagedDeploymentOrder(
  contracts: readonly ContractResource[],
): readonly string[] {
  const resources = new Map(contracts.map((resource) => [resource.id, resource]));
  const managed = contracts.filter((resource) => resource.kind === "managed");
  const managedIds = new Set(managed.map(({ id }) => id));
  const indexes = new Map(contracts.map((resource, index) => [resource.id, index]));
  const prerequisites = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const resource of managed) {
    const path = `manifest.contracts[${indexes.get(resource.id) ?? 0}].deployment.requiresRuntime`;
    const managedPrerequisites = new Set<string>();
    for (let index = 0; index < resource.deployment.requiresRuntime.length; index += 1) {
      const prerequisiteId = resource.deployment.requiresRuntime[index] as string;
      if (prerequisiteId === resource.id) {
        throw new MoesiManifestError(
          "invalid_deployment",
          `${path}[${index}]`,
          `resource ${resource.id} cannot require its own runtime`,
        );
      }
      if (!resources.has(prerequisiteId)) {
        throw new MoesiManifestError(
          "invalid_deployment",
          `${path}[${index}]`,
          `runtime prerequisite ${prerequisiteId} is not declared by the manifest`,
        );
      }
      if (!managedIds.has(prerequisiteId)) continue;
      managedPrerequisites.add(prerequisiteId);
      const owners = dependents.get(prerequisiteId) ?? new Set<string>();
      owners.add(resource.id);
      dependents.set(prerequisiteId, owners);
    }
    prerequisites.set(resource.id, managedPrerequisites);
  }

  const ready = managed
    .filter(({ id }) => prerequisites.get(id)?.size === 0)
    .map(({ id }) => id)
    .sort(compareAscii);
  const order: string[] = [];
  while (ready.length > 0) {
    const resourceId = ready.shift();
    if (resourceId === undefined) break;
    order.push(resourceId);
    for (const dependentId of [...(dependents.get(resourceId) ?? [])].sort(compareAscii)) {
      const remaining = prerequisites.get(dependentId);
      if (remaining === undefined) continue;
      remaining.delete(resourceId);
      if (remaining.size === 0) {
        ready.push(dependentId);
        ready.sort(compareAscii);
      }
    }
  }

  if (order.length !== managed.length) {
    const cyclicResourceId = managed
      .map(({ id }) => id)
      .filter((id) => !order.includes(id))
      .sort(compareAscii)[0];
    const index = cyclicResourceId === undefined ? 0 : (indexes.get(cyclicResourceId) ?? 0);
    throw new MoesiManifestError(
      "invalid_deployment",
      `manifest.contracts[${index}].deployment.requiresRuntime`,
      "managed deployment runtime prerequisites contain a cycle",
    );
  }

  return Object.freeze(order);
}
