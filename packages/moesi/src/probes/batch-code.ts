import type { Address, Hex } from "cetane";
import { encodeAbiParameters } from "cetane/utils";
import { type ProbeClientLike, parseProbeClient } from "./client.js";
import { MoesiProbeError } from "./error.js";
import { probeArray, probeBlockNumber, probeBooleans, probeRecord } from "./validation.js";

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

const OVERRIDE_BASE = 0xbad0n;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface BatchCodeResult {
  /** Lowercased address → hasCode; absent keys mean unreadable fallback evidence. */
  readonly results: Readonly<Partial<Record<string, boolean>>>;
  /** which path produced the evidence */
  readonly via: "state-override" | "getCode-fallback";
  /** how many unique addresses were checked */
  readonly count: number;
}

export interface BatchCodeOptions {
  /** Per-address reads are the default fallback; strict batch callers choose `none`. */
  readonly fallback?: "getCode" | "none";
  /** Optional exact block pin shared by every read in the probe. */
  readonly blockNumber?: bigint;
}

/**
 * Probe up to 1,024 address entries on one chain with one
 * RPC call when the provider honours state override. With
 * `fallback: "getCode"` (default) an unreadable state-override path degrades
 * to per-address `eth_getCode`; with `fallback: "none"` it throws
 * `MoesiProbeError("state-override-unreadable")` instead of degrading.
 * Failed per-address reads remain absent from results; absence is not false.
 */
export async function batchCheckCode(
  clientInput: ProbeClientLike,
  addresses: readonly string[],
  options: BatchCodeOptions = {},
): Promise<BatchCodeResult> {
  const optionsRecord = probeRecord(options, "invalid-probe-input", ["fallback", "blockNumber"]);
  const fallback = optionsRecord.fallback === undefined ? "getCode" : optionsRecord.fallback;
  if (fallback !== "getCode" && fallback !== "none") {
    throw new MoesiProbeError("invalid-probe-input", "fallback must be getCode or none");
  }
  const blockNumber = probeBlockNumber(optionsRecord.blockNumber);
  const entries = probeArray(addresses, 1024);
  const normalized = Object.freeze([
    ...new Set(
      entries.map((address) => {
        if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
          throw new MoesiProbeError("invalid-address", "batch code check received a non-address");
        }
        return address.toLowerCase() as Address;
      }),
    ),
  ]);
  const client = parseProbeClient(clientInput);
  if (normalized.length === 0)
    return Object.freeze({ results: Object.freeze({}), via: "state-override", count: 0 });
  const targets = new Set(normalized);
  let candidate = OVERRIDE_BASE;
  let overrideAt: Address;
  do {
    overrideAt = `0x${candidate.toString(16).padStart(40, "0")}`;
    candidate += 1n;
  } while (targets.has(overrideAt));
  const pin = blockNumber === undefined ? {} : { blockNumber };
  const callData: Hex = `0x00000000${encodeAbiParameters([{ type: "address[]" }], [normalized]).slice(2)}`;
  try {
    const result = await client.call({
      to: overrideAt,
      data: callData,
      stateOverride: [{ address: overrideAt, code: BATCH_CHECK_BYTECODE }],
      ...pin,
    });
    const bools = probeBooleans(result.data, normalized.length);
    const results = Object.freeze(
      Object.fromEntries(normalized.map((address, index) => [address, bools[index] === true])),
    );
    return Object.freeze({ results, via: "state-override", count: normalized.length });
  } catch {
    if (fallback === "none") {
      throw new MoesiProbeError(
        "state-override-unreadable",
        "state-override deployment probe was unreadable",
      );
    }
  }
  const entriesByAddress = await Promise.all(
    normalized.map(async (address) => {
      try {
        const code = await client.getCode({ address, ...pin });
        return [address, code !== "0x"] as const;
      } catch {
        // Failed or malformed responses remain absent, never false evidence.
        return null;
      }
    }),
  );
  const results = Object.freeze(
    Object.fromEntries(entriesByAddress.filter((entry) => entry !== null)),
  );
  return Object.freeze({ results, via: "getCode-fallback", count: normalized.length });
}
