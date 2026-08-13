import { type Address, decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { type ProbeClientLike, parseProbeClient } from "./client.js";
import { MoesiProbeError } from "./error.js";

/**
 * Batch contract-deployment check via one eth_call with state override.
 *
 * Instead of one `eth_getCode` per address (N roundtrips), a dummy address is
 * overridden with a tiny hand-assembled contract whose runtime reads
 * `address[]` from calldata, runs EXTCODESIZE on each entry, and returns
 * `bool[]`. The whole check is exactly one RPC call per chain regardless of
 * address count, modulo state-override support on the RPC.
 */
export const BATCH_CHECK_BYTECODE =
  "0x60206000526024358060205260005b818110156100315780602002604401353b1515816020026040015260010161000e565b506020026040016000f3" as const;

const OVERRIDE_AT = "0x000000000000000000000000000000000000bad0" as const;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface BatchCodeResult {
  /** address (lowercased) → hasCode */
  readonly results: Record<string, boolean>;
  /** which path produced the evidence */
  readonly via: "state-override" | "getCode-fallback";
  /** how many unique addresses were checked */
  readonly count: number;
}

export interface BatchCodeOptions {
  /** Compatibility fallback is the default; strict evidence callers choose `none`. */
  readonly fallback?: "getCode" | "none";
  /** Optional exact block pin shared by every read in the probe. */
  readonly blockNumber?: bigint;
}

/**
 * Probe up to `addresses.length` contract deployments on one chain with one
 * RPC call when the provider honours state override. With
 * `fallback: "getCode"` (default) an unreadable state-override path degrades
 * to per-address `eth_getCode`; with `fallback: "none"` it throws
 * `MoesiProbeError("state-override-unreadable")` instead of degrading.
 */
export async function batchCheckCode(
  clientInput: ProbeClientLike,
  addresses: readonly string[],
  options: BatchCodeOptions = {},
): Promise<BatchCodeResult> {
  const client = parseProbeClient(clientInput);
  if (addresses.length === 0) return { results: {}, via: "state-override", count: 0 };
  for (const address of addresses) {
    if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
      throw new MoesiProbeError("invalid-address", "batch code check received a non-address");
    }
  }
  const normalized = [...new Set(addresses.map((address) => address.toLowerCase() as Address))];
  const pin = options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber };
  const callData: Hex = `0x00000000${encodeAbiParameters([{ type: "address[]" }], [normalized]).slice(2)}`;
  try {
    const result = await client.call({
      to: OVERRIDE_AT,
      data: callData,
      stateOverride: [{ address: OVERRIDE_AT, code: BATCH_CHECK_BYTECODE }],
      ...pin,
    });
    if (!result.data || result.data === "0x") throw new Error("empty result");
    const [bools] = decodeAbiParameters([{ type: "bool[]" }], result.data);
    if (bools.length !== normalized.length) throw new Error("length mismatch");
    const results: Record<string, boolean> = {};
    normalized.forEach((address, index) => {
      results[address] = bools[index] === true;
    });
    return { results, via: "state-override", count: normalized.length };
  } catch (error) {
    if (error instanceof MoesiProbeError) throw error;
    if (options.fallback === "none") {
      throw new MoesiProbeError(
        "state-override-unreadable",
        "state-override deployment probe was unreadable",
      );
    }
  }
  const results: Record<string, boolean> = {};
  await Promise.all(
    normalized.map(async (address) => {
      try {
        const code = await client.getCode({ address, ...pin });
        results[address] = code !== undefined && code !== "0x";
      } catch {
        // Unreadable addresses stay absent rather than claiming evidence.
      }
    }),
  );
  return { results, via: "getCode-fallback", count: normalized.length };
}
