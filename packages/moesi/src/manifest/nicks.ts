import type { Address, Hex } from "cetane";
import {
  getAddress,
  isAddressEqual,
  keccak256,
  recoverAddress,
  toRlp,
  toRlpInteger,
} from "cetane/utils";
import { MoesiManifestError } from "../errors.js";

/**
 * Canonical Nick's-method signature components. The exact values are
 * fixed nonzero scalars with r below the curve order and s in its lower half;
 * these match the Multicall3 deployment transaction so recovered deployers
 * line up with existing public infrastructure documentation.
 */
export const NICKS_DEFAULT_V = 27n;
export const NICKS_DEFAULT_R =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
export const NICKS_DEFAULT_S =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export interface NicksTxParams {
  readonly initCode: Hex;
  /**
   * Bind the signature to one chain under EIP-155. Absent means the
   * transaction must be chain-neutral (`v` of 27 or 28); present means `v`
   * must be `2 * chainId + 35` or `+ 36` and defaults to `2 * chainId + 35`.
   */
  readonly chainId?: number;
  readonly gasPrice?: bigint;
  readonly gasLimit?: bigint;
  readonly value?: bigint;
  readonly v?: bigint;
  readonly r?: Hex;
  readonly s?: Hex;
}

export interface NicksAddressValidation {
  readonly isValid: boolean;
  /** The EIP-155 chain the signature is bound to, or null when chain-neutral. */
  readonly chainId: number | null;
  readonly expectedAddress: Address;
  readonly deployer: Address;
}

interface ResolvedNicksTxParams {
  readonly initCode: Hex;
  readonly chainId: number | null;
  readonly gasPrice: bigint;
  readonly gasLimit: bigint;
  readonly value: bigint;
  readonly v: bigint;
  readonly r: Hex;
  readonly s: Hex;
}

function fail(path: string, message: string): never {
  throw new MoesiManifestError("invalid_deployment", path, message);
}

/**
 * Classify a legacy signature `v`: 27/28 is chain-neutral, `>= 35` binds the
 * EIP-155 chain `(v - 35) / 2`, and anything else is not a valid legacy `v`.
 */
export function nicksSignatureChainId(v: bigint): number | null | undefined {
  if (typeof v !== "bigint") return undefined;
  if (v === 27n || v === 28n) return null;
  if (v < 37n) return undefined;
  const chainId = (v - 35n) / 2n;
  return chainId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(chainId) : undefined;
}

/** Validate caller-supplied Nick's-method fields once at the boundary. */
function resolveNicksTxParams(params: NicksTxParams): ResolvedNicksTxParams {
  let record: Record<string, unknown>;
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) throw null;
    const prototype = Object.getPrototypeOf(params);
    if (prototype !== null && prototype !== Object.prototype) throw null;
    record = Object.create(null) as Record<string, unknown>;
    const allowed = new Set([
      "initCode",
      "chainId",
      "gasPrice",
      "gasLimit",
      "value",
      "v",
      "r",
      "s",
    ]);
    for (const key of Object.keys(params)) {
      if (!allowed.has(key)) throw null;
      record[key] = Reflect.get(params, key);
    }
  } catch {
    fail("nicks", "Nick's-method parameters must be an exact readable record");
  }
  const chainId = record.chainId === undefined ? null : record.chainId;
  if (
    chainId !== null &&
    (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0)
  ) {
    fail("nicks.chainId", "chainId must be a positive safe integer");
  }
  const resolved = {
    initCode: record.initCode,
    chainId,
    gasPrice: record.gasPrice === undefined ? 100_000_000_000n : record.gasPrice,
    gasLimit: record.gasLimit === undefined ? 250_000n : record.gasLimit,
    value: record.value === undefined ? 0n : record.value,
    v:
      record.v === undefined
        ? chainId === null
          ? NICKS_DEFAULT_V
          : 2n * BigInt(chainId) + 35n
        : record.v,
    r: record.r === undefined ? NICKS_DEFAULT_R : record.r,
    s: record.s === undefined ? NICKS_DEFAULT_S : record.s,
  };
  if (typeof resolved.initCode !== "string" || !HEX_PATTERN.test(resolved.initCode)) {
    fail("nicks.initCode", "initCode must be whole-byte hex");
  }
  if (resolved.initCode === "0x") fail("nicks.initCode", "initCode must not be empty");
  for (const [key, quantity] of [
    ["gasPrice", resolved.gasPrice],
    ["gasLimit", resolved.gasLimit],
    ["value", resolved.value],
    ["v", resolved.v],
  ] as const) {
    if (typeof quantity !== "bigint" || quantity < 0n || quantity > MAX_UINT256) {
      fail(`nicks.${key}`, `${key} must be a uint256 bigint`);
    }
  }
  for (const [key, word] of [
    ["r", resolved.r],
    ["s", resolved.s],
  ] as const) {
    if (typeof word !== "string" || !BYTES32_PATTERN.test(word) || BigInt(word) === 0n) {
      fail(`nicks.${key}`, `${key} must be a non-zero 32-byte hex word`);
    }
  }
  const signatureChainId = nicksSignatureChainId(resolved.v as bigint);
  if (signatureChainId === undefined) {
    fail("nicks.v", "v must be 27 or 28, or an EIP-155 value of at least 37");
  }
  if (signatureChainId !== resolved.chainId) {
    if (resolved.chainId === null) {
      throw new MoesiManifestError(
        "chain_bound_nicks_signature",
        "nicks.v",
        "v binds an EIP-155 chain; pass that chainId to build or recover it",
      );
    }
    throw new MoesiManifestError(
      "nicks_chain_mismatch",
      "nicks.v",
      "v does not bind the requested chainId",
    );
  }
  if (resolved.gasLimit === 0n) fail("nicks.gasLimit", "gasLimit must be positive");
  if (BigInt(resolved.r as Hex) >= CURVE_ORDER) fail("nicks.r", "r must be below the curve order");
  if (BigInt(resolved.s as Hex) > CURVE_ORDER / 2n)
    fail("nicks.s", "s must be in the lower half of the curve order");
  return Object.freeze(resolved) as ResolvedNicksTxParams;
}

/**
 * Build the signed transaction bytes for a Nick's-method (presigned keyless)
 * deployment: RLP `[nonce=0, gasPrice, gasLimit, to=empty, value, initCode,
 * v, r, s]`. Without `chainId` this is the pre-EIP-155 legacy format every
 * chain replays identically; with it, the EIP-155 `v` makes only that chain
 * accept the transaction and the recovered deployer differs per chain.
 */
export function buildNicksTx(params: NicksTxParams): Hex {
  return serializeNicksTx(resolveNicksTxParams(params));
}

function serializeNicksTx(resolved: ResolvedNicksTxParams): Hex {
  const quantity = (value: bigint): Hex => toRlpInteger(value);
  return toRlp([
    "0x",
    quantity(resolved.gasPrice),
    quantity(resolved.gasLimit),
    "0x",
    quantity(resolved.value),
    resolved.initCode,
    quantity(resolved.v),
    quantity(BigInt(resolved.r)),
    quantity(BigInt(resolved.s)),
  ]);
}

/** Recover the keyless EOA that "signed" a Nick's-method transaction. */
export async function recoverNicksDeployer(params: NicksTxParams): Promise<Address> {
  return recoverResolvedNicksDeployer(resolveNicksTxParams(params));
}

async function recoverResolvedNicksDeployer(resolved: ResolvedNicksTxParams): Promise<Address> {
  try {
    const fields = [
      "0x",
      toRlpInteger(resolved.gasPrice),
      toRlpInteger(resolved.gasLimit),
      "0x",
      toRlpInteger(resolved.value),
      resolved.initCode,
    ] as Hex[];
    if (resolved.chainId !== null) fields.push(toRlpInteger(resolved.chainId), "0x", "0x");
    const yParity = Number(resolved.chainId === null ? resolved.v - 27n : (resolved.v - 35n) % 2n);
    return recoverAddress({
      hash: keccak256(toRlp(fields)),
      signature: { r: resolved.r, s: resolved.s, yParity },
    });
  } catch {
    // Recovery errors can embed serialized signatures. Never retain their cause.
    fail("nicks.signature", "Nick's-method signature could not recover a deployer");
  }
}

/** Predict the nonce-0 CREATE address of a recovered Nick's deployer. */
export function predictNicksAddress(recoveredDeployer: Address): Address {
  if (typeof recoveredDeployer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(recoveredDeployer)) {
    fail("nicks.deployer", "deployer must be a 20-byte address");
  }
  return getAddress(
    `0x${keccak256(toRlp([recoveredDeployer.toLowerCase() as Address, "0x"])).slice(26)}`,
  );
}

/**
 * Recover the keyless deployer, predict its nonce-0 CREATE address, and
 * compare it with a claimed deterministic deployment address.
 */
export async function validateNicksAddress(
  address: Address,
  params: NicksTxParams,
): Promise<NicksAddressValidation> {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    fail("nicks.address", "claimed address must be a 20-byte address");
  }
  const resolved = resolveNicksTxParams(params);
  const deployer = await recoverResolvedNicksDeployer(resolved);
  const expectedAddress = predictNicksAddress(deployer);
  return Object.freeze({
    isValid: isAddressEqual(address, expectedAddress),
    chainId: resolved.chainId,
    expectedAddress,
    deployer,
  });
}
