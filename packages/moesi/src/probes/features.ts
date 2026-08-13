import { concat, type Hex, size, toHex } from "viem";
import { OPCODE_PROBE_BYTECODES } from "./batch-opcodes.js";
import {
  isExecutionRevert,
  type ProbeClient,
  type ProbeClientLike,
  parseProbeClient,
} from "./client.js";

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

export interface ProbeOutcome {
  readonly supported: boolean | null;
  /** Structured probe-failure reason; never raw provider error text. */
  readonly error?: "transport-failed" | "unsupported-client" | "unknown-feature";
}

const SINGLETON_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const;
const SALT = `0x${"0".repeat(64)}` as const;
const DUMMY_ADDRESS = "0xdeadbeef00000000000000000000000000000000" as const;
const EIP7702_CODE = "0xef01000000000000000000000000000000000000000001" as const;
const RIP7212_ADDRESS = "0x0000000000000000000000000000000000000100" as const;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const BLS12_G1ADD = "0x000000000000000000000000000000000000000b" as const;

/** Newest → oldest — the order the version-detection algorithm scans. */
export const HARDFORK_ORDER = [
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
] as const;

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
      description: "Beacon chain randomness (replaces DIFFICULTY)",
    },
    {
      id: "difficultyZero",
      name: "difficulty == 0 (PoS)",
      hardfork: "Paris (Merge)",
      checkType: "blockHeader",
      category: "evm",
      description: "Block difficulty is zero, indicating Proof-of-Stake",
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
      description: "EOA can execute smart contract code via eth_estimateGas code override",
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
      name: "secp256r1 / P-256 (RIP-7212)",
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
export function listKnownFeatures(): FeatureDefinition[] {
  return [
    ...HARDFORK_ORDER.flatMap((hardfork) => HARDFORK_FEATURES[hardfork]),
    ...PROTOCOL_FEATURES,
  ];
}

async function checkOpcode(
  client: ProbeClient,
  bytecode: Hex,
  blockNumber?: bigint,
): Promise<boolean> {
  const pin = blockNumber === undefined ? {} : { blockNumber };
  try {
    const factoryCode = await client.getCode({ address: SINGLETON_FACTORY, ...pin });
    if (factoryCode && factoryCode !== "0x") {
      await client.call({ to: SINGLETON_FACTORY, data: concat([SALT, bytecode]), ...pin });
    } else {
      await client.call({
        to: DUMMY_ADDRESS,
        data: "0x",
        stateOverride: [{ address: DUMMY_ADDRESS, code: bytecode }],
        ...pin,
      });
    }
    return true;
  } catch (error) {
    if (isExecutionRevert(error)) return false;
    throw error;
  }
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
  if (field === "baseFeeHeader") {
    return block.baseFeePerGas !== undefined && block.baseFeePerGas !== null;
  }
  return block.difficulty === 0n;
}

async function checkAccessListSupport(client: ProbeClient, blockNumber?: bigint): Promise<boolean> {
  if (!client.request) throw new UnsupportedClientError();
  try {
    await client.request({
      method: "eth_createAccessList",
      params: [
        { from: DUMMY_ADDRESS, to: DUMMY_ADDRESS, data: "0x" },
        blockNumber === undefined ? "latest" : toHex(blockNumber),
      ],
    });
    return true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (
      message.includes("method not found") ||
      message.includes("not supported") ||
      message.includes("does not exist")
    ) {
      return false;
    }
    if (
      isExecutionRevert(error) ||
      message.includes("insufficient") ||
      message.includes("invalid")
    ) {
      return true;
    }
    throw error;
  }
}

async function checkContractDeployed(
  client: ProbeClient,
  address: `0x${string}`,
  blockNumber?: bigint,
): Promise<boolean> {
  const pin = blockNumber === undefined ? {} : { blockNumber };
  const code = await client.getCode({ address, ...pin });
  return code !== undefined && code !== "0x" && code.length > 2;
}

async function checkEip7702(client: ProbeClient, blockNumber?: bigint): Promise<boolean> {
  if (!client.request) throw new UnsupportedClientError();
  try {
    await client.request({
      method: "eth_estimateGas",
      params: [
        {
          from: DUMMY_ADDRESS,
          to: DUMMY_ADDRESS,
          data: "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
          value: "0x0",
        },
        blockNumber === undefined ? "latest" : toHex(blockNumber),
        { [DUMMY_ADDRESS]: { code: EIP7702_CODE } },
      ],
    });
    return true;
  } catch (error) {
    if (isExecutionRevert(error)) return false;
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (
      message.includes("invalid params") ||
      message.includes("method not found") ||
      message.includes("unsupported")
    ) {
      return false;
    }
    throw error;
  }
}

async function checkRip7212(client: ProbeClient, blockNumber?: bigint): Promise<boolean> {
  const pin = blockNumber === undefined ? {} : { blockNumber };
  try {
    const data = concat([
      "0x267f9ea080b54bbea2443dff8aa543604564329783b6a515c6663a691c555490",
      "0x01655c1753db6b61a9717e4ccc5d6c4bf7681623dd54c2d6babc55125756661c",
      "0xf073023b6de130f18510af41f64f067c39adccd59f8789a55dbbe822b0ea2317",
      "0x65a2fa44daad46eab0278703edb6c4dcf5e30b8a9aec09fdc71a56f52aa392e4",
      "0x4a7a9e4604aa36898209997288e902ac544a555e4b5e0a9efef2b59233f3f437",
    ]);
    const result = await client.call({ to: RIP7212_ADDRESS, data, ...pin });
    return result.data !== undefined && size(result.data) === 32;
  } catch (error) {
    if (isExecutionRevert(error)) return false;
    throw error;
  }
}

async function checkBls12381(client: ProbeClient, blockNumber?: bigint): Promise<boolean> {
  const pin = blockNumber === undefined ? {} : { blockNumber };
  try {
    const data = `0x${"00".repeat(256)}` as Hex;
    const result = await client.call({ to: BLS12_G1ADD, data, ...pin });
    return result.data !== undefined && size(result.data) === 128;
  } catch (error) {
    if (isExecutionRevert(error)) return false;
    throw error;
  }
}

class UnsupportedClientError extends Error {
  readonly probeOutcome = "unsupported-client" as const;
}

const KNOWN_FEATURE_IDS = new Set(listKnownFeatures().map(({ id }) => id));

async function checkFeatureSupport(
  client: ProbeClient,
  featureId: string,
  blockNumber?: bigint,
): Promise<boolean> {
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
    case "difficultyZero":
      return checkBlock(client, "difficultyZero", blockNumber);
    case "baseFeeHeader":
      return checkBlock(client, "baseFeeHeader", blockNumber);
    case "accessList":
      return checkAccessListSupport(client, blockNumber);
    case "eip7702":
      return checkEip7702(client, blockNumber);
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
  const client = parseProbeClient(clientInput);
  if (!KNOWN_FEATURE_IDS.has(featureId)) {
    return { supported: null, error: "unknown-feature" };
  }
  try {
    return { supported: await checkFeatureSupport(client, featureId, blockNumber) };
  } catch (error) {
    return {
      supported: null,
      error: error instanceof UnsupportedClientError ? "unsupported-client" : "transport-failed",
    };
  }
}
