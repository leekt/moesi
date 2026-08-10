import { type Address, concatHex, encodeFunctionData, type Hex } from "viem";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATEX_FACTORY_V1_ADDRESS,
  deriveCreateXCreate2RawSalt,
  deriveResourceAddress,
} from "../manifest/target.js";
import type {
  ConfigurationRule,
  ManagedContractResource,
  ManagedDeployment,
  ManifestSender,
} from "../manifest/types.js";
import type { DeploymentCall, PlanEnforcement, StepSender } from "./types.js";
import { DEFAULT_PLAN_ENFORCEMENT } from "./types.js";

export {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATEX_FACTORY_V1_ADDRESS,
  deriveCreateXCreate2RawSalt,
  deriveResourceAddress,
};

export const CREATE2_FACTORY_V1_RUNTIME_CODE_HASH =
  "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989" as const satisfies Hex;

export const CREATEX_FACTORY_V1_RUNTIME_CODE_HASH =
  "0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f" as const satisfies Hex;

export const CREATEX_DEPLOY_CREATE2_SELECTOR = "0x26307668" as const satisfies Hex;

const CREATEX_CREATE2_ABI = [
  {
    type: "function",
    name: "deployCreate2",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "initCode", type: "bytes" },
    ],
    outputs: [{ name: "newContract", type: "address" }],
  },
] as const;

type DeploymentCapabilitySpec =
  | {
      readonly kind: "create2-factory-v1";
      readonly address: typeof CREATE2_FACTORY_V1_ADDRESS;
      readonly expectedRuntimeCodeHash: typeof CREATE2_FACTORY_V1_RUNTIME_CODE_HASH;
    }
  | {
      readonly kind: "createx-factory-v1";
      readonly address: typeof CREATEX_FACTORY_V1_ADDRESS;
      readonly expectedRuntimeCodeHash: typeof CREATEX_FACTORY_V1_RUNTIME_CODE_HASH;
    };

/** Closed mapping from each supported deployment to its required chain fact. */
export function deploymentCapabilitySpec(deployment: ManagedDeployment): DeploymentCapabilitySpec {
  if (deployment.kind === "create2-factory-v1") {
    return {
      kind: "create2-factory-v1",
      address: CREATE2_FACTORY_V1_ADDRESS,
      expectedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
    };
  }
  if (deployment.kind === "createx-create2-v1") {
    return {
      kind: "createx-factory-v1",
      address: CREATEX_FACTORY_V1_ADDRESS,
      expectedRuntimeCodeHash: CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
    };
  }
  const unsupported: never = deployment;
  throw new Error(`unsupported deployment capability ${String(unsupported)}`);
}

export const ZERO_CONFIGURATION_CALLER = "0x0000000000000000000000000000000000000000";

export function compileDeploymentCall(resource: ManagedContractResource): DeploymentCall {
  if (resource.deployment.kind === "createx-create2-v1") {
    if (resource.sender?.kind !== "owner-eoa") {
      throw new Error("parsed CreateX CREATE2 resource lost its owner-eoa sender");
    }
    const rawSalt = deriveCreateXCreate2RawSalt({
      sender: resource.sender.address,
      entropy: resource.deployment.entropy,
    });
    const data = encodeFunctionData({
      abi: CREATEX_CREATE2_ABI,
      functionName: "deployCreate2",
      args: [rawSalt, resource.deployment.initCode],
    });
    if (!data.startsWith(CREATEX_DEPLOY_CREATE2_SELECTOR)) {
      throw new Error("CreateX deployCreate2 ABI selector changed");
    }
    return {
      target: CREATEX_FACTORY_V1_ADDRESS,
      data,
      value: resource.deployment.value,
    };
  }
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
