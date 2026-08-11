import { type Address, getCreate2Address, keccak256 } from "viem";
import type { ContractResource, ManagedContractResource } from "./types.js";

export const CREATE2_FACTORY_V1_ADDRESS =
  "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const satisfies Address;

export function deriveManagedResourceAddress(resource: ManagedContractResource): Address {
  return getCreate2Address({
    from: CREATE2_FACTORY_V1_ADDRESS,
    salt: resource.deployment.salt,
    bytecodeHash: keccak256(resource.deployment.initCode),
  }).toLowerCase() as Address;
}

/** Exact chain address targeted by either manifest resource kind. */
export function deriveResourceAddress(resource: ContractResource): Address {
  return resource.kind === "external"
    ? (resource.address.toLowerCase() as Address)
    : deriveManagedResourceAddress(resource);
}
