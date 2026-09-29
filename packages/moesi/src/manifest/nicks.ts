import {
  type Address,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  recoverTransactionAddress,
  type TransactionSerializedLegacy,
  toHex,
  toRlp,
} from "viem";
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
  readonly gasPrice?: bigint;
  readonly gasLimit?: bigint;
  readonly value?: bigint;
  readonly v?: bigint;
  readonly r?: Hex;
  readonly s?: Hex;
}

export interface NicksAddressValidation {
  readonly isValid: boolean;
  readonly expectedAddress: Address;
  readonly deployer: Address;
}

interface ResolvedNicksTxParams {
  readonly initCode: Hex;
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

/** Validate caller-supplied Nick's-method fields once at the boundary. */
function resolveNicksTxParams(params: NicksTxParams): ResolvedNicksTxParams {
  let record: Record<string, unknown>;
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) throw null;
    const prototype = Object.getPrototypeOf(params);
    if (prototype !== null && prototype !== Object.prototype) throw null;
    record = Object.create(null) as Record<string, unknown>;
    const allowed = new Set(["initCode", "gasPrice", "gasLimit", "value", "v", "r", "s"]);
    for (const key of Object.keys(params)) {
      if (!allowed.has(key)) throw null;
      record[key] = Reflect.get(params, key);
    }
  } catch {
    fail("nicks", "Nick's-method parameters must be an exact readable record");
  }
  const resolved = {
    initCode: record.initCode,
    gasPrice: record.gasPrice === undefined ? 100_000_000_000n : record.gasPrice,
    gasLimit: record.gasLimit === undefined ? 250_000n : record.gasLimit,
    value: record.value === undefined ? 0n : record.value,
    v: record.v === undefined ? NICKS_DEFAULT_V : record.v,
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
  if (resolved.v !== 27n && resolved.v !== 28n) {
    fail("nicks.v", "a chain-neutral legacy transaction requires v of 27 or 28");
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
 * v, r, s]` in the pre-EIP-155 legacy format every chain replays identically.
 */
export function buildNicksTx(params: NicksTxParams): Hex {
  const resolved = resolveNicksTxParams(params);
  const quantity = (value: bigint): Hex => (value === 0n ? "0x" : toHex(value));
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
  // A Nick's tx is always the pre-typed legacy format, which viem types as a
  // template narrower than Hex; the runtime value is exactly that format.
  const transaction = buildNicksTx(params) as TransactionSerializedLegacy;
  try {
    return await recoverTransactionAddress({ serializedTransaction: transaction });
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
  const deployer = await recoverNicksDeployer(params);
  const expectedAddress = predictNicksAddress(deployer);
  return Object.freeze({
    isValid: isAddressEqual(address, expectedAddress),
    expectedAddress,
    deployer,
  });
}
