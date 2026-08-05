import type { Hex } from "viem";
import { MoesiPlanningError } from "../errors.js";
import type {
  CallObservation,
  CallReadRequest,
  ChainSnapshot,
  CodeReadRequest,
  MoesiObservationAdapter,
  RuntimeCodeObservation,
} from "./types.js";

const SNAPSHOT_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const CODE_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const BLOCK_NUMBER_PATTERN = /^(?:0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;

export async function captureChainSnapshot(
  observer: MoesiObservationAdapter,
  chainId: number,
): Promise<ChainSnapshot> {
  let value: unknown;
  try {
    value = await observer.captureSnapshot(chainId);
  } catch {
    throw new MoesiPlanningError(
      "snapshot_unreadable",
      chainId,
      `snapshot is unreadable for chain ${chainId}`,
    );
  }
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not a record");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("not a plain record");
    }
    const record = Object.create(null) as Record<string, unknown>;
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "blockNumber" && key !== "blockHash")) {
      throw new Error("unknown field");
    }
    for (const key of keys) record[key] = Reflect.get(value, key);
    if (
      typeof record.blockNumber !== "string" ||
      !BLOCK_NUMBER_PATTERN.test(record.blockNumber) ||
      BigInt(record.blockNumber) > MAX_UINT256
    ) {
      throw new Error("invalid block number");
    }
    if (typeof record.blockHash !== "string" || !SNAPSHOT_HASH_PATTERN.test(record.blockHash)) {
      throw new Error("invalid block hash");
    }
    return {
      chainId,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash.toLowerCase() as Hex,
    };
  } catch {
    throw new MoesiPlanningError("invalid_snapshot", chainId, "snapshot is invalid");
  }
}

export async function observeRuntimeCode(
  observer: MoesiObservationAdapter,
  request: CodeReadRequest,
): Promise<RuntimeCodeObservation> {
  let value: unknown;
  try {
    value = await observer.readCode(request);
  } catch {
    return { kind: "unreadable", reason: "read-failed" };
  }
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    return { kind: "unreadable", reason: "invalid-response" };
  }
  return { kind: "readable", code: value.toLowerCase() as Hex };
}

export async function observeCall(
  observer: MoesiObservationAdapter,
  request: CallReadRequest,
): Promise<CallObservation> {
  let value: unknown;
  try {
    value = await observer.readCall(request);
  } catch {
    return { kind: "unreadable", reason: "read-failed" };
  }
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    return { kind: "unreadable", reason: "invalid-response" };
  }
  return { kind: "readable", result: value.toLowerCase() as Hex };
}
