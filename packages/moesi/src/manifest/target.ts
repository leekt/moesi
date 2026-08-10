import {
  type Address,
  concatHex,
  encodeAbiParameters,
  getCreate2Address,
  type Hex,
  isAddress,
  keccak256,
} from "viem";
import { MoesiManifestError } from "../errors.js";
import type { ContractResource, ManagedContractResource } from "./types.js";

export const CREATE2_FACTORY_V1_ADDRESS =
  "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const satisfies Address;

export const CREATEX_FACTORY_V1_ADDRESS =
  "0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed" as const satisfies Address;

const CREATEX_ENTROPY_PATTERN = /^0x[0-9a-fA-F]{22}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Exact raw salt passed to sender-protected CreateX CREATE2. */
export function deriveCreateXCreate2RawSalt(input: {
  readonly sender: Address;
  readonly entropy: Hex;
}): Hex {
  let sender: unknown;
  let entropy: unknown;
  try {
    sender = Reflect.get(input, "sender");
    entropy = Reflect.get(input, "entropy");
  } catch {
    throw new MoesiManifestError(
      "invalid_deployment",
      "createXRawSalt",
      "CreateX raw salt input is unreadable",
    );
  }
  if (
    typeof sender !== "string" ||
    !isAddress(sender, { strict: false }) ||
    sender.toLowerCase() === ZERO_ADDRESS
  ) {
    throw new MoesiManifestError(
      "invalid_sender",
      "sender",
      "CreateX sender must be a non-zero 20-byte address",
    );
  }
  if (typeof entropy !== "string" || !CREATEX_ENTROPY_PATTERN.test(entropy)) {
    throw new MoesiManifestError(
      "invalid_deployment",
      "entropy",
      "CreateX entropy must be exactly 11 bytes of hex",
    );
  }
  return concatHex([sender.toLowerCase() as Address, "0x00", entropy.toLowerCase() as Hex]);
}

export function deriveManagedResourceAddress(resource: ManagedContractResource): Address {
  if (resource.deployment.kind === "createx-create2-v1") {
    if (resource.sender?.kind !== "owner-eoa" || resource.sender.address === ZERO_ADDRESS) {
      throw new MoesiManifestError(
        "invalid_sender",
        "resource.sender",
        "CreateX CREATE2 deployment requires a non-zero owner-eoa sender",
      );
    }
    const rawSalt = deriveCreateXCreate2RawSalt({
      sender: resource.sender.address,
      entropy: resource.deployment.entropy,
    });
    const guardedSalt = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "bytes32" }],
        [resource.sender.address, rawSalt],
      ),
    );
    return getCreate2Address({
      from: CREATEX_FACTORY_V1_ADDRESS,
      salt: guardedSalt,
      bytecodeHash: keccak256(resource.deployment.initCode),
    }).toLowerCase() as Address;
  }
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
