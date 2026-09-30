import { type Address, type Hex, keccak256 } from "viem";
import { MoesiManifestError } from "../errors.js";
import { captureChainSnapshot, observeRuntimeCode } from "../observation/observe.js";
import type {
  ChainSnapshot,
  MoesiObservationAdapter,
  RuntimeCodeObservation,
} from "../observation/types.js";

const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Exact `expectedRuntimeCodeHash` for deployed runtime bytes, such as a
 * compiler's `deployedBytecode` without unresolved links or immutables. Use
 * `prepareSolidityArtifact` when the runtime depends on links or immutables.
 */
export function deriveRuntimeCodeHash(runtimeCode: Hex): Hex {
  if (typeof runtimeCode !== "string" || !HEX_PATTERN.test(runtimeCode)) {
    throw new MoesiManifestError(
      "invalid_resource",
      "runtimeCode",
      "runtime code must be whole-byte hex",
    );
  }
  if (runtimeCode === "0x") {
    throw new MoesiManifestError(
      "invalid_resource",
      "runtimeCode",
      "runtime code must not be empty",
    );
  }
  return keccak256(runtimeCode.toLowerCase() as Hex);
}

export interface ObserveRuntimeIdentityInput {
  readonly observer: MoesiObservationAdapter;
  readonly chainId: number;
  /** An address the caller has already verified, such as a predicted target. */
  readonly address: Address;
  /** When present, the result reports whether the observed runtime matches it. */
  readonly expectedRuntimeCodeHash?: Hex;
}

interface RuntimeIdentityBase {
  readonly chainId: number;
  readonly address: Address;
  readonly snapshot: ChainSnapshot;
}

/** Pinned runtime identity evidence at one address; never a deployment decision. */
export type RuntimeIdentityObservation =
  | (RuntimeIdentityBase & {
      readonly kind: "observed";
      readonly runtimeCodeHash: Hex;
      /** Null when no expected hash was supplied. */
      readonly matchesExpected: boolean | null;
    })
  | (RuntimeIdentityBase & { readonly kind: "absent" })
  | (RuntimeIdentityBase & {
      readonly kind: "unreadable";
      readonly reason: Extract<RuntimeCodeObservation, { kind: "unreadable" }>["reason"];
    });

/**
 * Read the runtime code at one address and one pinned snapshot, and derive its
 * `expectedRuntimeCodeHash`. Observed code is authoring evidence: adopting it
 * as desired state is the caller's explicit decision, never Moesi's.
 */
export async function observeRuntimeIdentity(
  input: ObserveRuntimeIdentityInput,
): Promise<RuntimeIdentityObservation> {
  let observer: unknown;
  let chainId: unknown;
  let address: unknown;
  let expected: unknown;
  try {
    observer = Reflect.get(input, "observer");
    chainId = Reflect.get(input, "chainId");
    address = Reflect.get(input, "address");
    expected = Reflect.get(input, "expectedRuntimeCodeHash");
  } catch {
    fail("input", "runtime identity input is unreadable");
  }
  if (typeof observer !== "object" || observer === null) {
    fail("observer", "an observation adapter is required");
  }
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    fail("chainId", "chainId must be a positive safe integer");
  }
  if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
    fail("address", "address must be a 20-byte address");
  }
  if (expected !== undefined && (typeof expected !== "string" || !BYTES32_PATTERN.test(expected))) {
    fail("expectedRuntimeCodeHash", "expectedRuntimeCodeHash must be a 32-byte hash");
  }
  const adapter = observer as MoesiObservationAdapter;
  const snapshot = await captureChainSnapshot(adapter, chainId);
  const base = { chainId, address: address.toLowerCase() as Address, snapshot };
  const observed = await observeRuntimeCode(adapter, {
    chainId,
    address: base.address,
    snapshot,
  });
  if (observed.kind === "unreadable") {
    // Never retain raw provider causes in authoring evidence.
    return Object.freeze({ ...base, kind: "unreadable", reason: observed.reason });
  }
  if (observed.code === "0x") return Object.freeze({ ...base, kind: "absent" });
  const runtimeCodeHash = keccak256(observed.code);
  return Object.freeze({
    ...base,
    kind: "observed",
    runtimeCodeHash,
    matchesExpected:
      expected === undefined ? null : runtimeCodeHash === (expected as Hex).toLowerCase(),
  });
}

function fail(path: string, message: string): never {
  throw new MoesiManifestError("invalid_resource", path, message);
}
