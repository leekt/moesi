import { type Address, concatHex, type Hex } from "viem";
import { CREATE2_FACTORY_V1_ADDRESS, deriveResourceAddress } from "../manifest/target.js";
import type {
  ConfigurationRule,
  ManagedContractResource,
  ManifestSender,
} from "../manifest/types.js";
import type { DeploymentCall, PlanEnforcement, StepSender } from "./types.js";
import { DEFAULT_PLAN_ENFORCEMENT } from "./types.js";

export { CREATE2_FACTORY_V1_ADDRESS, deriveResourceAddress };

export const CREATE2_FACTORY_V1_RUNTIME_CODE_HASH =
  "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989" as const satisfies Hex;

export const ZERO_CONFIGURATION_CALLER = "0x0000000000000000000000000000000000000000";

export function compileDeploymentCall(resource: ManagedContractResource): DeploymentCall {
  return {
    target: CREATE2_FACTORY_V1_ADDRESS,
    data: concatHex([resource.deployment.salt, resource.deployment.initCode]),
    value: resource.deployment.value,
  };
}

export function compileConfigurationCall(
  address: Address,
  rule: ConfigurationRule,
): DeploymentCall {
  return { target: address, data: rule.writeData, value: rule.value };
}

export function compileResourceSender(sender: ManifestSender | undefined): StepSender | null {
  if (sender === undefined) return null;
  if (sender.kind === "owner-eoa") {
    return { kind: "reviewed-owner-eoa", address: sender.address };
  }
  return { kind: "logical-smart-account", accountId: sender.accountId };
}

export function compileResourceEnforcement(resource: ManagedContractResource): PlanEnforcement {
  return resource.enforcement ?? DEFAULT_PLAN_ENFORCEMENT;
}

export function compileConfigurationCaller(resource: ManagedContractResource): Address {
  return resource.sender?.kind === "owner-eoa"
    ? resource.sender.address
    : ZERO_CONFIGURATION_CALLER;
}
