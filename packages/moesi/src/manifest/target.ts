import type { Address, Hex } from "cetane";
import {
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  getCreate2Address,
  isAddress,
  keccak256,
} from "cetane/utils";
import { MoesiManifestError } from "../errors.js";
import type {
  ContractResource,
  DeploymentRecipe,
  ManagedDeployment,
  ManifestContractResource,
  ManifestSender,
} from "./types.js";

export const CREATE2_FACTORY_V1_ADDRESS =
  "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const satisfies Address;

export const CREATEX_FACTORY_V1_ADDRESS =
  "0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed" as const satisfies Address;

const CREATEX_ENTROPY_PATTERN = /^0x[0-9a-fA-F]{22}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Exact raw salt passed to sender-protected CreateX CREATE2 or CREATE3. */
export function deriveCreateXSenderProtectedRawSalt(input: {
  readonly sender: Address;
  readonly entropy: Hex;
}): Hex {
  return senderRawSalt(input, "0x00");
}

/**
 * Exact raw salt passed to sender-and-crosschain-protected CreateX:
 * `sender(20) || 0x01 || entropy(11)`.
 */
export function deriveCreateXSenderCrosschainRawSalt(input: {
  readonly sender: Address;
  readonly entropy: Hex;
}): Hex {
  return senderRawSalt(input, "0x01");
}

function senderRawSalt(input: unknown, flag: Hex): Hex {
  let sender: unknown;
  let entropy: unknown;
  try {
    sender = Reflect.get(input as object, "sender");
    entropy = Reflect.get(input as object, "entropy");
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
  return concatHex([sender.toLowerCase() as Address, flag, createXEntropy(entropy)]);
}

function createXEntropy(entropy: unknown): Hex {
  if (typeof entropy !== "string" || !CREATEX_ENTROPY_PATTERN.test(entropy)) {
    throw new MoesiManifestError(
      "invalid_deployment",
      "entropy",
      "CreateX entropy must be exactly 11 bytes of hex",
    );
  }
  return entropy.toLowerCase() as Hex;
}

/**
 * Exact raw salt passed to unguarded CreateX deployments:
 * `zero-address(20) || 0x00 || entropy(11)`. CreateX's `_parseSalt` classifies
 * it as (ZeroAddress, no redeploy protection), which its `_guard` hashes as
 * `keccak256(abi.encode(rawSalt))` for every sender — proven on-chain against
 * the pinned CreateX runtime. The 0x00 flag byte is load-bearing: any other
 * unstructured flag (e.g. 0x02) makes CreateX revert `InvalidSalt`.
 */
export function deriveCreateXUnguardedRawSalt(entropyInput: unknown): Hex {
  return concatHex([ZERO_ADDRESS, "0x00", createXEntropy(entropyInput)]);
}

/**
 * Exact raw salt passed to crosschain-protected CreateX deployments:
 * `zero-address(20) || 0x01 || entropy(11)`, which CreateX hashes as
 * `keccak256(abi.encode(block.chainid, rawSalt))` for every sender.
 */
export function deriveCreateXCrosschainRawSalt(entropyInput: unknown): Hex {
  return concatHex([ZERO_ADDRESS, "0x01", createXEntropy(entropyInput)]);
}

/** CreateX's fixed CREATE3 proxy init code hash. */
export const CREATEX_CREATE3_PROXY_INIT_CODE_HASH = keccak256("0x67363d3d37363d34f03d5260086018f3");

type CreateXGuard = "sender" | "unguarded" | "crosschain" | "sender-crosschain";

const CREATEX_STRATEGIES = {
  "createx-create2-v1": { guard: "sender", create3: false },
  "createx-create3-v1": { guard: "sender", create3: true },
  "createx-create2-unguarded-v1": { guard: "unguarded", create3: false },
  "createx-create3-unguarded-v1": { guard: "unguarded", create3: true },
  "createx-create2-crosschain-v1": { guard: "crosschain", create3: false },
  "createx-create3-crosschain-v1": { guard: "crosschain", create3: true },
  "createx-create2-sender-crosschain-v1": { guard: "sender-crosschain", create3: false },
  "createx-create3-sender-crosschain-v1": { guard: "sender-crosschain", create3: true },
} as const satisfies Record<
  Exclude<ManagedDeployment["kind"], "create2-factory-v1">,
  { readonly guard: CreateXGuard; readonly create3: boolean }
>;

export interface CreateXSalts {
  readonly rawSalt: Hex;
  /** The salt CreateX's `_guard` passes to CREATE2 for this exact recipe. */
  readonly guardedSalt: Hex;
  readonly create3: boolean;
}

export type CreateXDeployment = Exclude<ManagedDeployment, { kind: "create2-factory-v1" }>;

/** Exact raw and guarded salts for one CreateX deployment and its declared sender. */
export function deriveCreateXSalts(
  deployment: CreateXDeployment,
  declaredSender: ManifestSender | undefined,
): CreateXSalts {
  const { guard, create3 } = CREATEX_STRATEGIES[deployment.kind];
  if (guard === "unguarded") {
    const rawSalt = deriveCreateXUnguardedRawSalt(deployment.entropy);
    return {
      rawSalt,
      guardedSalt: keccak256(encodeAbiParameters([{ type: "bytes32" }], [rawSalt])),
      create3,
    };
  }
  const chainId = BigInt("chainId" in deployment ? deployment.chainId : 0);
  if (guard === "crosschain") {
    const rawSalt = deriveCreateXCrosschainRawSalt(deployment.entropy);
    return {
      rawSalt,
      guardedSalt: keccak256(
        encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [chainId, rawSalt]),
      ),
      create3,
    };
  }
  if (declaredSender === undefined || declaredSender.address === ZERO_ADDRESS) {
    throw new MoesiManifestError(
      "invalid_sender",
      "resource.sender",
      "sender-protected CreateX deployment requires a non-zero exact sender",
    );
  }
  const sender = declaredSender.address;
  if (guard === "sender") {
    const rawSalt = deriveCreateXSenderProtectedRawSalt({ sender, entropy: deployment.entropy });
    return {
      rawSalt,
      guardedSalt: keccak256(
        encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [sender, rawSalt]),
      ),
      create3,
    };
  }
  const rawSalt = deriveCreateXSenderCrosschainRawSalt({ sender, entropy: deployment.entropy });
  return {
    rawSalt,
    guardedSalt: keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        [sender, chainId, rawSalt],
      ),
    ),
    create3,
  };
}

/** The only chain a resource targets, or null when its address is chain-independent. */
export function resourceChainBinding(
  resource: ManifestContractResource | ContractResource,
): number | null {
  if (resource.kind !== "managed" || !("chainId" in resource.deployment)) return null;
  return resource.deployment.chainId;
}

export function deriveManagedResourceAddress(resource: DeploymentRecipe): Address {
  if (resource.deployment.kind === "create2-factory-v1") {
    return getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: resource.deployment.salt,
      bytecodeHash: keccak256(resource.deployment.initCode),
    }).toLowerCase() as Address;
  }
  const salts = deriveCreateXSalts(resource.deployment, resource.sender);
  // CREATE3: a proxy is CREATE2-deployed from the guarded salt, then the
  // contract is CREATE-deployed by that proxy at nonce 1, so the final
  // address is independent of initCode.
  const deployed = getCreate2Address({
    from: CREATEX_FACTORY_V1_ADDRESS,
    salt: salts.guardedSalt,
    bytecodeHash: salts.create3
      ? CREATEX_CREATE3_PROXY_INIT_CODE_HASH
      : keccak256(resource.deployment.initCode),
  });
  return (
    salts.create3 ? getContractAddress({ opcode: "CREATE", from: deployed, nonce: 1n }) : deployed
  ).toLowerCase() as Address;
}

/** Exact chain address targeted by either manifest resource kind. */
export function deriveResourceAddress(resource: ManifestContractResource): Address {
  return resource.kind === "external"
    ? (resource.address.toLowerCase() as Address)
    : deriveManagedResourceAddress(resource);
}
