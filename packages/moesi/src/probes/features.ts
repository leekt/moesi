import { type Hex, toHex } from "viem";
import { deepFreeze } from "../internal.js";
import { OPCODE_PROBE_BYTECODES, simulateProbeCalls } from "./batch-opcodes.js";
import { type ProbeClient, type ProbeClientLike, parseProbeClient } from "./client.js";
import { MoesiProbeError } from "./error.js";
import { probeArray, probeBlockNumber, probeRecord } from "./validation.js";

export type FeatureCheckType =
  | "opcode"
  | "rpcMethod"
  | "blockHeader"
  | "custom"
  | "contractDeployed";
export type FeatureCategory = "evm" | "protocol";

export interface FeatureDefinition {
  readonly id: string;
  readonly name: string;
  readonly hardfork: string | null;
  readonly checkType: FeatureCheckType;
  readonly category: FeatureCategory;
  readonly description: string;
}

export type ProbeOutcome =
  | { readonly supported: boolean }
  | {
      readonly supported: null;
      readonly error:
        | "transport-failed"
        | "unsupported-client"
        | "unknown-feature"
        | "invalid-response"
        | "inconclusive";
    };

const SINGLETON_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const;
const DUMMY_ADDRESS = "0xdeadbeef00000000000000000000000000000000" as const;
// Public conformance vector from https://eips.ethereum.org/assets/eip-7951/test-vectors.json.
const P256_INPUT =
  "0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca6050232ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e184cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd762927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e" as const;
const P256_RESULT = `0x${"00".repeat(31)}01` as const;
const RIP7212_ADDRESS = "0x0000000000000000000000000000000000000100" as const;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const BLS12_G1ADD = "0x000000000000000000000000000000000000000b" as const;

/** Newest → oldest — the order the version-detection algorithm scans. */
export const HARDFORK_ORDER = Object.freeze([
  "Osaka (Fusaka)",
  "Prague (Pectra)",
  "Cancun",
  "Shanghai",
  "Paris (Merge)",
  "London",
  "Berlin",
  "Istanbul",
  "Constantinople",
  "Byzantium",
] as const);

const HARDFORK_FEATURES: Record<(typeof HARDFORK_ORDER)[number], readonly FeatureDefinition[]> = {
  Byzantium: [
    {
      id: "returndatasize",
      name: "RETURNDATASIZE (0x3D)",
      hardfork: "Byzantium",
      checkType: "opcode",
      category: "evm",
      description: "Returns the size of the output data from the previous call",
    },
  ],
  Constantinople: [
    {
      id: "shl",
      name: "SHL (0x1B)",
      hardfork: "Constantinople",
      checkType: "opcode",
      category: "evm",
      description: "Bitwise shift left",
    },
    {
      id: "shr",
      name: "SHR (0x1C)",
      hardfork: "Constantinople",
      checkType: "opcode",
      category: "evm",
      description: "Bitwise logical shift right",
    },
    {
      id: "extcodehash",
      name: "EXTCODEHASH (0x3F)",
      hardfork: "Constantinople",
      checkType: "opcode",
      category: "evm",
      description: "Hash of a contract's code",
    },
  ],
  Istanbul: [
    {
      id: "chainid",
      name: "CHAINID (0x46)",
      hardfork: "Istanbul",
      checkType: "opcode",
      category: "evm",
      description: "Current chain ID",
    },
    {
      id: "selfbalance",
      name: "SELFBALANCE (0x47)",
      hardfork: "Istanbul",
      checkType: "opcode",
      category: "evm",
      description: "Balance of the executing account",
    },
  ],
  Berlin: [
    {
      id: "accessList",
      name: "Access Lists (EIP-2930)",
      hardfork: "Berlin",
      checkType: "rpcMethod",
      category: "evm",
      description: "eth_createAccessList RPC method support",
    },
  ],
  London: [
    {
      id: "basefee",
      name: "BASEFEE (0x48)",
      hardfork: "London",
      checkType: "opcode",
      category: "evm",
      description: "Current block base fee (EIP-1559)",
    },
    {
      id: "baseFeeHeader",
      name: "baseFeePerGas in block",
      hardfork: "London",
      checkType: "blockHeader",
      category: "evm",
      description: "baseFeePerGas field present in block header",
    },
  ],
  "Paris (Merge)": [
    {
      id: "prevrandao",
      name: "PREVRANDAO (0x44)",
      hardfork: "Paris (Merge)",
      checkType: "opcode",
      category: "evm",
      description:
        "EIP-4399 threshold: opcode 0x44 returns more than 2**64; smaller values remain inconclusive",
    },
    {
      id: "difficultyZero",
      name: "difficulty == 0 (PoS)",
      hardfork: "Paris (Merge)",
      checkType: "blockHeader",
      category: "evm",
      description:
        "Block difficulty equals zero; this alone is not a consensus or opcode-support proof",
    },
  ],
  Shanghai: [
    {
      id: "push0",
      name: "PUSH0 (0x5F)",
      hardfork: "Shanghai",
      checkType: "opcode",
      category: "evm",
      description: "Pushes 0 onto the stack",
    },
  ],
  Cancun: [
    {
      id: "tload",
      name: "TLOAD (0x5C)",
      hardfork: "Cancun",
      checkType: "opcode",
      category: "evm",
      description: "Load from transient storage",
    },
    {
      id: "tstore",
      name: "TSTORE (0x5D)",
      hardfork: "Cancun",
      checkType: "opcode",
      category: "evm",
      description: "Store to transient storage",
    },
    {
      id: "mcopy",
      name: "MCOPY (0x5E)",
      hardfork: "Cancun",
      checkType: "opcode",
      category: "evm",
      description: "Memory copy",
    },
    {
      id: "blobbasefee",
      name: "BLOBBASEFEE (0x4A)",
      hardfork: "Cancun",
      checkType: "opcode",
      category: "evm",
      description: "Current blob base fee (EIP-4844)",
    },
  ],
  "Prague (Pectra)": [
    {
      id: "eip7702",
      name: "EIP-7702 (Account Code)",
      hardfork: "Prague (Pectra)",
      checkType: "custom",
      category: "evm",
      description:
        "Inconclusive: code overrides cannot establish activation of EIP-7702 authorization transactions",
    },
    {
      id: "bls12381",
      name: "BLS12-381 Precompile (EIP-2537)",
      hardfork: "Prague (Pectra)",
      checkType: "custom",
      category: "evm",
      description: "BLS12-381 elliptic curve operations precompile at 0x0b",
    },
  ],
  "Osaka (Fusaka)": [
    {
      id: "clz",
      name: "CLZ (0x1E)",
      hardfork: "Osaka (Fusaka)",
      checkType: "opcode",
      category: "evm",
      description: "Count leading zero bits in a 256-bit value (EIP-7939)",
    },
    {
      id: "rip7212",
      name: "secp256r1 / P-256 (EIP-7951 / RIP-7212)",
      hardfork: "Osaka (Fusaka)",
      checkType: "custom",
      category: "evm",
      description: "Native precompile for secp256r1 (P-256) curve at 0x0100",
    },
  ],
};

const PROTOCOL_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "create2Proxy",
    name: "Create2Proxy",
    hardfork: null,
    checkType: "contractDeployed",
    category: "protocol",
    description: "Singleton factory at 0x4e59...956c",
  },
  {
    id: "multicall3",
    name: "Multicall3",
    hardfork: null,
    checkType: "contractDeployed",
    category: "protocol",
    description: "Multicall3 at 0xcA11...CA11",
  },
];

/** The complete known chain-feature catalog, newest hardfork first. */
export function listKnownFeatures(): readonly FeatureDefinition[] {
  return deepFreeze(
    [
      ...HARDFORK_ORDER.flatMap((hardfork) => HARDFORK_FEATURES[hardfork]),
      ...PROTOCOL_FEATURES,
    ].map((feature) => ({ ...feature })),
  );
}

async function checkOpcode(
  client: ProbeClient,
  bytecode: Hex,
  blockNumber?: bigint,
): Promise<boolean> {
  const outcomes = await simulateProbeCalls(client, [bytecode], blockNumber);
  return outcomes[0] === true;
}

async function checkBlock(
  client: ProbeClient,
  field: "baseFeeHeader" | "difficultyZero",
  blockNumber?: bigint,
): Promise<boolean> {
  if (!client.getBlock) throw new UnsupportedClientError();
  const block = await client.getBlock(
    blockNumber === undefined ? { blockTag: "latest" } : { blockNumber },
  );
  if (field === "baseFeeHeader")
    return block.baseFeePerGas !== undefined && block.baseFeePerGas !== null;
  if (block.difficulty === undefined)
    throw new MoesiProbeError("invalid-response", "block difficulty is missing");
  return block.difficulty === 0n;
}

async function checkPrevRandao(client: ProbeClient, blockNumber?: bigint): Promise<true | null> {
  const result = await client.call({
    to: DUMMY_ADDRESS,
    data: "0x",
    stateOverride: [{ address: DUMMY_ADDRESS, code: "0x4460005260206000f3" }],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  if (result.data === undefined || result.data.length !== 66)
    throw new MoesiProbeError("invalid-response", "randomness probe returned an invalid word");
  return BigInt(result.data) > 1n << 64n ? true : null;
}

async function checkAccessListSupport(client: ProbeClient, blockNumber?: bigint): Promise<boolean> {
  if (!client.request) throw new UnsupportedClientError();
  let result: unknown;
  try {
    result = await client.request({
      method: "eth_createAccessList",
      params: [
        { from: DUMMY_ADDRESS, to: DUMMY_ADDRESS, data: "0x" },
        blockNumber === undefined ? "latest" : toHex(blockNumber),
      ],
    });
  } catch (error) {
    if (error instanceof MoesiProbeError && error.code === "method-unavailable") return false;
    throw error;
  }
  try {
    const record = probeRecord(result, "invalid-response");
    if (
      "error" in record ||
      typeof record.gasUsed !== "string" ||
      !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(record.gasUsed)
    )
      throw null;
    for (const entry of probeArray(record.accessList, 1024)) {
      const item = probeRecord(entry, "invalid-response", ["address", "storageKeys"]);
      if (typeof item.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(item.address)) throw null;
      for (const key of probeArray(item.storageKeys, 1024)) {
        if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw null;
      }
    }
  } catch {
    throw new MoesiProbeError("invalid-response", "access-list probe returned invalid evidence");
  }
  return true;
}

async function checkContractDeployed(
  client: ProbeClient,
  address: `0x${string}`,
  blockNumber?: bigint,
): Promise<boolean> {
  const code = await client.getCode({
    address,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return code !== "0x";
}

async function checkRip7212(client: ProbeClient, blockNumber?: bigint): Promise<boolean> {
  const result = await client.call({
    to: RIP7212_ADDRESS,
    data: P256_INPUT,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  if (result.data === "0x") return false;
  if (result.data !== P256_RESULT)
    throw new MoesiProbeError("invalid-response", "P-256 probe returned an unexpected result");
  return true;
}

async function checkBls12381(client: ProbeClient, blockNumber?: bigint): Promise<boolean> {
  const result = await client.call({
    to: BLS12_G1ADD,
    data: `0x${"00".repeat(256)}`,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  if (result.data === "0x") return false;
  if (result.data !== `0x${"00".repeat(128)}`)
    throw new MoesiProbeError("invalid-response", "BLS probe returned an unexpected result");
  return true;
}

class UnsupportedClientError extends Error {
  readonly probeOutcome = "unsupported-client" as const;
}

const KNOWN_FEATURE_IDS = new Set(listKnownFeatures().map(({ id }) => id));

async function checkFeatureSupport(
  client: ProbeClient,
  featureId: string,
  blockNumber?: bigint,
): Promise<boolean | null> {
  switch (featureId) {
    case "returndatasize":
    case "shl":
    case "shr":
    case "extcodehash":
    case "chainid":
    case "selfbalance":
    case "basefee":
    case "push0":
    case "tload":
    case "tstore":
    case "mcopy":
    case "blobbasefee":
    case "clz":
      return checkOpcode(client, OPCODE_PROBE_BYTECODES[featureId], blockNumber);
    case "prevrandao":
      return checkPrevRandao(client, blockNumber);
    case "difficultyZero":
      return checkBlock(client, "difficultyZero", blockNumber);
    case "baseFeeHeader":
      return checkBlock(client, "baseFeeHeader", blockNumber);
    case "accessList":
      return checkAccessListSupport(client, blockNumber);
    case "eip7702":
      // Simulators can execute overridden delegation code even before Prague.
      // A read-only code override does not test authorization processing or
      // transaction-type activation, so it cannot establish EIP-7702 support.
      return null;
    case "bls12381":
      return checkBls12381(client, blockNumber);
    case "rip7212":
      return checkRip7212(client, blockNumber);
    case "create2Proxy":
      return checkContractDeployed(client, SINGLETON_FACTORY, blockNumber);
    case "multicall3":
      return checkContractDeployed(client, MULTICALL3, blockNumber);
    default:
      return false;
  }
}

/**
 * Probe one known feature through a caller-owned client with an optional
 * exact block pin. Transport failures resolve to `supported: null` with a
 * structured reason — raw provider error text is never retained.
 */
export async function runFeatureProbe(
  clientInput: ProbeClientLike,
  featureId: string,
  blockNumber?: bigint,
): Promise<ProbeOutcome> {
  const block = probeBlockNumber(blockNumber);
  if (typeof featureId !== "string" || featureId.length > 128) {
    throw new MoesiProbeError("invalid-probe-input", "feature ID must be a bounded string");
  }
  const client = parseProbeClient(clientInput);
  if (!KNOWN_FEATURE_IDS.has(featureId))
    return Object.freeze({ supported: null, error: "unknown-feature" });
  try {
    const supported = await checkFeatureSupport(client, featureId, block);
    return Object.freeze(
      supported === null ? { supported: null, error: "inconclusive" } : { supported },
    );
  } catch (error) {
    return Object.freeze({
      supported: null,
      error:
        error instanceof UnsupportedClientError
          ? "unsupported-client"
          : error instanceof MoesiProbeError && error.code === "invalid-response"
            ? "invalid-response"
            : "transport-failed",
    });
  }
}
