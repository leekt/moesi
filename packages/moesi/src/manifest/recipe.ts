import type { Address } from "cetane";
import { deepFreeze } from "../internal.js";
import { compileDeploymentCall } from "../planning/resource.js";
import type { DeploymentCall } from "../planning/types.js";
import { parseDeploymentRecipe } from "./parse.js";
import { deriveManagedResourceAddress } from "./target.js";
import type { DeploymentRecipe } from "./types.js";

export type CompiledDeploymentRecipe = DeploymentRecipe & {
  readonly address: Address;
  readonly call: DeploymentCall;
};

/**
 * Predict and encode a captured recipe with the planner's exact implementation.
 * This is authoring data, not a reviewed plan, runtime expectation, observation,
 * provider review or execution authorization. No RPC or wallet is consulted.
 */
export function compileDeploymentRecipe(input: DeploymentRecipe): CompiledDeploymentRecipe {
  const recipe = parseDeploymentRecipe(input);
  return deepFreeze({
    ...recipe,
    address: deriveManagedResourceAddress(recipe),
    call: compileDeploymentCall(recipe),
  });
}
