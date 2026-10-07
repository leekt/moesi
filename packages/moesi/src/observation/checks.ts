import type { Hex } from "cetane";
import type { ReviewedCallCheck, ReviewedStorageCheck } from "../planning/types.js";
import { observeCall, observeStorage } from "./observe.js";
import type {
  CallObservation,
  ChainSnapshot,
  MoesiObservationAdapter,
  StorageObservation,
} from "./types.js";

const WORD = /^0x[0-9a-f]{64}$/;
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/;

export function isValidCallCheckResult(check: ReviewedCallCheck, result: Hex): boolean {
  if (check.kind === "call") return true;
  if (check.kind === "access-control-admin-role") return WORD.test(result);
  if (check.kind === "access-control-member") return WORD.test(result) && BigInt(result) <= 1n;
  return ADDRESS_WORD.test(result);
}

export function isValidStorageCheckResult(check: ReviewedStorageCheck, result: Hex): boolean {
  return check.kind === "word" || ADDRESS_WORD.test(result);
}

export async function observeReviewedCallCheck(
  observer: MoesiObservationAdapter,
  snapshot: ChainSnapshot,
  check: ReviewedCallCheck,
): Promise<CallObservation> {
  const result = await observeCall(observer, {
    chainId: snapshot.chainId,
    snapshot,
    target: check.target,
    caller: check.caller,
    data: check.readData,
  });
  return result.kind === "readable" && !isValidCallCheckResult(check, result.result)
    ? { kind: "unreadable", reason: "invalid-response" }
    : result;
}

export async function observeReviewedStorageCheck(
  observer: MoesiObservationAdapter,
  snapshot: ChainSnapshot,
  address: `0x${string}`,
  check: ReviewedStorageCheck,
): Promise<StorageObservation> {
  const result = await observeStorage(observer, {
    chainId: snapshot.chainId,
    snapshot,
    address,
    slot: check.slot,
  });
  return result.kind === "readable" && !isValidStorageCheckResult(check, result.word)
    ? { kind: "unreadable", reason: "invalid-response" }
    : result;
}
