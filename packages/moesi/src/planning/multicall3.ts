import type { Address, Hex } from "cetane";
import { decodeFunctionData, encodeFunctionData } from "cetane/utils";
import { MoesiPlanError } from "../errors.js";
import { deepFreeze, mapArrayElements, snapshotArray } from "../internal.js";
import type { DeploymentCall } from "./types.js";

/** Canonical Multicall3, deployed at the same address on every chain that has it. */
export const MULTICALL3_ADDRESS =
  "0xca11bde05977b3631167028862be2a173976ca11" as const satisfies Address;

/** keccak256 of the canonical Multicall3 runtime (3808 bytes). */
export const MULTICALL3_RUNTIME_CODE_HASH =
  "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891" as const satisfies Hex;

/** Largest batch one reviewed `aggregate` call may carry. */
export const MAX_MULTICALL3_CALLS = 256;

const MULTICALL3_AGGREGATE_ABI = [
  {
    type: "function",
    name: "aggregate",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "blockNumber", type: "uint256" },
      { name: "returnData", type: "bytes[]" },
    ],
  },
] as const;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * Pack value-free calls into one Multicall3 `aggregate` call an EOA can send.
 * Multicall3 becomes every inner call's `msg.sender`, so batch only
 * sender-independent calls, such as CREATE2-factory or unguarded and
 * crosschain CreateX deployments. `aggregate` reverts the whole transaction
 * when any inner call fails.
 */
export function encodeMulticall3Aggregate(calls: readonly DeploymentCall[]): DeploymentCall {
  const entries = snapshotArray(calls);
  if (entries === null || entries.length === 0 || entries.length > MAX_MULTICALL3_CALLS) {
    throw new MoesiPlanError(
      "invalid_call",
      "calls",
      `Multicall3 batches require 1 to ${MAX_MULTICALL3_CALLS} calls`,
    );
  }
  const exact = mapArrayElements(entries, (entry, index) => parseValueFreeCall(entry, index));
  return deepFreeze({
    target: MULTICALL3_ADDRESS,
    data: encodeFunctionData({
      abi: MULTICALL3_AGGREGATE_ABI,
      functionName: "aggregate",
      args: [exact.map(({ target, data }) => ({ target, callData: data }))],
    }),
    value: "0",
  });
}

/** Decode canonical `aggregate` calldata back into its exact inner calls, or null. */
export function decodeMulticall3Aggregate(data: Hex): readonly DeploymentCall[] | null {
  try {
    const decoded = decodeFunctionData({ abi: MULTICALL3_AGGREGATE_ABI, data });
    if (decoded.functionName !== "aggregate") return null;
    const calls = (decoded.args[0] as readonly { target: Address; callData: Hex }[]).map(
      ({ target, callData }) => ({
        target: target.toLowerCase() as Address,
        data: callData.toLowerCase() as Hex,
        value: "0",
      }),
    );
    // Reject non-canonical encodings so evidence binds exactly one byte string.
    if (calls.length === 0 || encodeMulticall3Aggregate(calls).data !== data.toLowerCase()) {
      return null;
    }
    return deepFreeze(calls);
  } catch {
    return null;
  }
}

function parseValueFreeCall(entry: unknown, index: number): DeploymentCall {
  const path = `calls[${index}]`;
  let target: unknown;
  let data: unknown;
  let value: unknown;
  try {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw null;
    if (Object.keys(entry).some((key) => key !== "target" && key !== "data" && key !== "value")) {
      throw null;
    }
    target = Reflect.get(entry, "target");
    data = Reflect.get(entry, "data");
    value = Reflect.get(entry, "value");
  } catch {
    throw new MoesiPlanError("invalid_call", path, "call must be an exact { target, data, value }");
  }
  if (typeof target !== "string" || !ADDRESS_PATTERN.test(target)) {
    throw new MoesiPlanError("invalid_call", `${path}.target`, "call target must be an address");
  }
  if (typeof data !== "string" || !HEX_PATTERN.test(data)) {
    throw new MoesiPlanError("invalid_call", `${path}.data`, "call data must be whole-byte hex");
  }
  if (value !== "0") {
    throw new MoesiPlanError(
      "invalid_call",
      `${path}.value`,
      'Multicall3 aggregate calls carry no value; value must be "0"',
    );
  }
  return {
    target: target.toLowerCase() as Address,
    data: data.toLowerCase() as Hex,
    value: "0",
  };
}
