import { type Address, concatHex, getCreate2Address, type Hex, keccak256 } from "viem";
import type { ConfigurationRule, ContractResource, ManifestSender } from "../manifest/types.js";
import type { DeploymentCall, PlanEnforcement, StepSender } from "./types.js";
import { DEFAULT_PLAN_ENFORCEMENT } from "./types.js";

export const CREATE2_FACTORY_V1_ADDRESS =
  "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const satisfies Address;

export const CREATE2_FACTORY_V1_RUNTIME_CODE_HASH =
  "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989" as const satisfies Hex;

export const ZERO_CONFIGURATION_CALLER = "0x0000000000000000000000000000000000000000";

export function deriveResourceAddress(resource: ContractResource): Address {
  return getCreate2Address({
    from: CREATE2_FACTORY_V1_ADDRESS,
    salt: resource.deployment.salt,
    bytecodeHash: keccak256(resource.deployment.initCode),
  }).toLowerCase() as Address;
}

export function compileDeploymentCall(resource: ContractResource): DeploymentCall {
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

export function compileResourceEnforcement(resource: ContractResource): PlanEnforcement {
  return resource.enforcement ?? DEFAULT_PLAN_ENFORCEMENT;
}

export function compileConfigurationCaller(resource: ContractResource): Address {
  return resource.sender?.kind === "owner-eoa"
    ? resource.sender.address
    : ZERO_CONFIGURATION_CALLER;
}
