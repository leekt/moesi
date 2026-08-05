import { type Address, encodeFunctionData, getCreate2Address, keccak256 } from "viem";
import type { ConfigurationRule, ContractResource, ManifestSender } from "../manifest/types.js";
import type { DeploymentCall, PlanEnforcement, StepSender } from "./types.js";
import { DEFAULT_PLAN_ENFORCEMENT } from "./types.js";

const CREATE2_FACTORY_ABI = [
  {
    type: "function",
    name: "deploy",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "initCode", type: "bytes" },
    ],
    outputs: [{ name: "deployed", type: "address" }],
  },
] as const;

export const ZERO_CONFIGURATION_CALLER = "0x0000000000000000000000000000000000000000";

export function deriveResourceAddress(resource: ContractResource): Address {
  return getCreate2Address({
    from: resource.deployment.factory,
    salt: resource.deployment.salt,
    bytecodeHash: keccak256(resource.deployment.initCode),
  }).toLowerCase() as Address;
}

export function compileDeploymentCall(resource: ContractResource): DeploymentCall {
  return {
    target: resource.deployment.factory,
    data: encodeFunctionData({
      abi: CREATE2_FACTORY_ABI,
      functionName: "deploy",
      args: [resource.deployment.salt, resource.deployment.initCode],
    }),
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
