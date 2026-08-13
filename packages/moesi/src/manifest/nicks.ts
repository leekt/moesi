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
 * arbitrary as long as both are non-zero and r is below the curve order;
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
  const resolved = {
    initCode: params.initCode,
    gasPrice: params.gasPrice ?? 100_000_000_000n,
    gasLimit: params.gasLimit ?? 250_000n,
    value: params.value ?? 0n,
    v: params.v ?? NICKS_DEFAULT_V,
    r: params.r ?? NICKS_DEFAULT_R,
    s: params.s ?? NICKS_DEFAULT_S,
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
  return resolved;
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
    resolved.r,
    resolved.s,
  ]);
}

/** Recover the keyless EOA that "signed" a Nick's-method transaction. */
export function recoverNicksDeployer(params: NicksTxParams): Promise<Address> {
  // A Nick's tx is always the pre-typed legacy format, which viem types as a
  // template narrower than Hex; the runtime value is exactly that format.
  return recoverTransactionAddress({
    serializedTransaction: buildNicksTx(params) as TransactionSerializedLegacy,
  });
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
  return {
    isValid: isAddressEqual(address, expectedAddress),
    expectedAddress,
    deployer,
  };
}
