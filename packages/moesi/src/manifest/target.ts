import {
  type Address,
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  getCreate2Address,
  type Hex,
  isAddress,
  keccak256,
} from "viem";
import { MoesiManifestError } from "../errors.js";
import type { ManifestContractResource, ManifestManagedResource } from "./types.js";

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

/**
 * Exact raw salt passed to unguarded CreateX deployments:
 * `zero-address(20) || 0x00 || entropy(11)`. CreateX's `_parseSalt` classifies
 * it as (ZeroAddress, no redeploy protection), which its `_guard` hashes as
 * `keccak256(abi.encode(rawSalt))` for every sender — proven on-chain against
 * the pinned CreateX runtime. The 0x00 flag byte is load-bearing: any other
 * unstructured flag (e.g. 0x02) makes CreateX revert `InvalidSalt`.
 */
export function deriveCreateXUnguardedRawSalt(entropyInput: unknown): Hex {
  if (typeof entropyInput !== "string" || !CREATEX_ENTROPY_PATTERN.test(entropyInput)) {
    throw new MoesiManifestError(
      "invalid_deployment",
      "entropy",
      "CreateX entropy must be exactly 11 bytes of hex",
    );
  }
  return concatHex([ZERO_ADDRESS, "0x00", entropyInput.toLowerCase() as Hex]);
}

/** CreateX's fixed CREATE3 proxy init code hash. */
export const CREATEX_CREATE3_PROXY_INIT_CODE_HASH = keccak256("0x67363d3d37363d34f03d5260086018f3");

function unguardedSalt(entropy: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }], [deriveCreateXUnguardedRawSalt(entropy)]),
  );
}

export function deriveManagedResourceAddress(resource: ManifestManagedResource): Address {
  if (resource.deployment.kind === "createx-create2-unguarded-v1") {
    return getCreate2Address({
      from: CREATEX_FACTORY_V1_ADDRESS,
      salt: unguardedSalt(resource.deployment.entropy),
      bytecodeHash: keccak256(resource.deployment.initCode),
    }).toLowerCase() as Address;
  }
  if (resource.deployment.kind === "createx-create3-unguarded-v1") {
    // CREATE3: a proxy is CREATE2-deployed from the guarded salt, then the
    // contract is CREATE-deployed by that proxy at nonce 1, so the final
    // address is independent of initCode.
    const proxy = getCreate2Address({
      from: CREATEX_FACTORY_V1_ADDRESS,
      salt: unguardedSalt(resource.deployment.entropy),
      bytecodeHash: CREATEX_CREATE3_PROXY_INIT_CODE_HASH,
    });
    return getContractAddress({
      opcode: "CREATE",
      from: proxy,
      nonce: 1n,
    }).toLowerCase() as Address;
  }
  if (
    resource.deployment.kind === "createx-create2-v1" ||
    resource.deployment.kind === "createx-create3-v1"
  ) {
    if (resource.sender === undefined || resource.sender.address === ZERO_ADDRESS) {
      throw new MoesiManifestError(
        "invalid_sender",
        "resource.sender",
        "sender-protected CreateX deployment requires a non-zero exact sender",
      );
    }
    const rawSalt = deriveCreateXSenderProtectedRawSalt({
      sender: resource.sender.address,
      entropy: resource.deployment.entropy,
    });
    const guardedSalt = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "bytes32" }],
        [resource.sender.address, rawSalt],
      ),
    );
    const create3 = resource.deployment.kind === "createx-create3-v1";
    const deployed = getCreate2Address({
      from: CREATEX_FACTORY_V1_ADDRESS,
      salt: guardedSalt,
      bytecodeHash: create3
        ? CREATEX_CREATE3_PROXY_INIT_CODE_HASH
        : keccak256(resource.deployment.initCode),
    });
    return (
      create3 ? getContractAddress({ opcode: "CREATE", from: deployed, nonce: 1n }) : deployed
    ).toLowerCase() as Address;
  }
  return getCreate2Address({
    from: CREATE2_FACTORY_V1_ADDRESS,
    salt: resource.deployment.salt,
    bytecodeHash: keccak256(resource.deployment.initCode),
  }).toLowerCase() as Address;
}

/** Exact chain address targeted by either manifest resource kind. */
export function deriveResourceAddress(resource: ManifestContractResource): Address {
  return resource.kind === "external"
    ? (resource.address.toLowerCase() as Address)
    : deriveManagedResourceAddress(resource);
}
