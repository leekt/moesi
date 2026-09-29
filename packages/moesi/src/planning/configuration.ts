import { mergeConfigurationWrites } from "../manifest/batch.js";
import type { ConfigurationRule, ManagedContractResource } from "../manifest/types.js";
import {
  compileConfigurationCall,
  compileConfigurationCaller,
  compileResourceEnforcement,
  compileResourceSender,
} from "./resource.js";
import type { DeploymentStep, ResourceCell } from "./types.js";

/** One canonical compilation used by planning and persisted-plan validation. */
export function compileConfigurationSteps(
  resource: ManagedContractResource,
  cell: ResourceCell,
): DeploymentStep[] {
  const ready = new Set(
    cell.configuration
      .filter((rule) => rule.readiness === undefined || rule.readiness === "ready")
      .map(({ id }) => id),
  );
  const selected = new Set(
    cell.status.kind === "missing"
      ? resource.configuration.map(({ id }) => id)
      : cell.status.kind === "drift"
        ? cell.status.configurationMismatches.map(({ id }) => id)
        : [],
  );
  const steps: DeploymentStep[] = [];
  const groups: ConfigurationRule[][] = [];
  for (const rule of resource.configuration) {
    const last = groups.at(-1);
    if (rule.batch && last?.[0]?.batch?.key === rule.batch.key) last.push(rule);
    else groups.push([rule]);
  }
  for (const group of groups) {
    const rows = group.filter(({ id }) => selected.has(id) && ready.has(id));
    const maxRows = group[0]?.batch?.maxRows ?? 1;
    for (let index = 0; index < rows.length; index += maxRows) {
      const chunk = rows.slice(index, index + maxRows);
      const first = chunk[0]!;
      steps.push({
        id: `${resource.id}:configure:${first.id}`,
        resourceId: resource.id,
        chainId: cell.chainId,
        kind: "configure",
        configurationIds: chunk.map(({ id }) => id),
        drift: cell.status.kind === "missing" ? "missing" : "configuration-drift",
        call: first.batch
          ? { target: cell.address, data: mergeConfigurationWrites(chunk), value: "0" }
          : compileConfigurationCall(cell.address, first),
        postconditions: chunk.map((rule) => ({
          kind: "static-call",
          target: cell.address,
          data: rule.readData,
          caller: compileConfigurationCaller(resource),
          expectedResult: rule.expectedResult,
        })),
        sender: compileResourceSender(resource.sender),
        enforcement: compileResourceEnforcement(resource),
      });
    }
  }
  return steps;
}
