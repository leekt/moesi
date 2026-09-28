import type { OaathCallsReview, OaathOperationExecution, OaathOwnerCallsReview } from "@oaath/sdk";
import type { DeploymentCall } from "moesi";
import { keccak256, toHex } from "viem";

export type OAAthAdapterErrorCode =
  | "oaath_input_invalid"
  | "oaath_sdk_invalid"
  | "oaath_grant_required"
  | "oaath_permission_failed"
  | "oaath_review_unavailable"
  | "oaath_review_changed"
  | "oaath_session_validation_failed"
  | "oaath_sender_incompatible"
  | "oaath_action_invalid"
  | "oaath_submission_failed"
  | "oaath_owner_required";

export class OAAthAdapterError extends Error {
  constructor(readonly code: OAAthAdapterErrorCode) {
    super(code);
    this.name = "OAAthAdapterError";
  }
}
export function fail(code: OAAthAdapterErrorCode): never {
  throw new OAAthAdapterError(code);
}

/** Capture JSON data once, without executing getters or retaining mutable SDK data. */
export function capture(
  value: unknown,
  depth = 0,
  budget = { nodes: 100_000, bytes: 4_194_304 },
): unknown {
  budget.nodes -= 1;
  if (typeof value === "string") budget.bytes -= value.length;
  if (depth > 20 || budget.nodes < 0 || budget.bytes < 0) return fail("oaath_sdk_invalid");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= 1_048_576) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "object" || value === null) return fail("oaath_sdk_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length > 65536 || keys.length !== length + 1)
      return fail("oaath_sdk_invalid");
    return Object.freeze(
      Array.from({ length }, (_, i) => {
        const d = descriptors[String(i)];
        if (!d || !("value" in d)) return fail("oaath_sdk_invalid");
        return capture(d.value, depth + 1, budget);
      }),
    );
  }
  const proto = Object.getPrototypeOf(value);
  if (
    (proto !== Object.prototype && proto !== null) ||
    keys.some((k) => typeof k !== "string") ||
    keys.length > 64
  )
    return fail("oaath_sdk_invalid");
  return Object.freeze(
    Object.fromEntries(
      (keys as string[]).sort().map((key) => {
        const d = descriptors[key];
        if (!d || !("value" in d) || !d.enumerable) return fail("oaath_sdk_invalid");
        return [key, capture(d.value, depth + 1, budget)];
      }),
    ),
  );
}

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("oaath_sdk_invalid");
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    return fail("oaath_sdk_invalid");
  return value as Record<string, unknown>;
}
export function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return fail("oaath_sdk_invalid");
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d || !("value" in d)) return fail("oaath_sdk_invalid");
  return d.value;
}
export function method<T extends (...args: never[]) => unknown>(value: unknown, key: string): T {
  const fn = field(value, key);
  if (typeof fn !== "function") return fail("oaath_sdk_invalid");
  return fn.bind(value) as T;
}
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(capture(a)) === JSON.stringify(capture(b));
}
export function fingerprint(value: unknown): string {
  return keccak256(toHex(JSON.stringify(capture(value)))).slice(2);
}
export function text(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
export const ADDRESS = /^0x[0-9a-f]{40}$/;
export const HASH = /^0x[0-9a-f]{64}$/;
export function grantId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
  );
}
export const ID = /^[A-Za-z0-9._:-]{1,128}$/;
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function calls(value: unknown): readonly DeploymentCall[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    return fail("oaath_sdk_invalid");
  for (const item of value) {
    const c = record(item, ["target", "data", "value"]);
    if (
      !text(c.target, ADDRESS) ||
      !text(c.data, /^0x(?:[0-9a-f]{2})*$/) ||
      !text(c.value, /^(0|[1-9][0-9]{0,77})$/) ||
      BigInt(c.value) >= 2n ** 256n
    )
      return fail("oaath_sdk_invalid");
  }
  return value;
}
const REASONS = new Set([
  "root_operation_requires_owner",
  "owner_explicit",
  "session_covers_calls",
  "session_calls_uncovered",
  "session_coverage_unreadable",
  "bundler_available",
  "bundler_absent",
  "bundler_unsupported",
  "bundler_unreadable",
  "fee_payer_configured",
  "fee_payer_absent",
]);

export function readReview(
  value: unknown,
  chainId: number,
  expected: readonly DeploymentCall[],
): Readonly<OaathCallsReview> {
  const r = record(capture(value), [
    "validation",
    "grantId",
    "chainId",
    "fallback",
    "paymasterService",
    "enableVerificationGasFloor",
    "accountId",
    "account",
    "calls",
    "signer",
    "route",
    "reasons",
    "enforcement",
    "expiresAt",
    "validAfter",
    "validUntil",
    "perChainOperationLimit",
  ]);
  readFallback(r.fallback);
  readSponsorshipReview(r.paymasterService);
  if (
    r.enableVerificationGasFloor !== null &&
    !text(r.enableVerificationGasFloor, /^(0|[1-9][0-9]{0,38})$/)
  )
    return fail("oaath_sdk_invalid");
  const e = record(r.enforcement, ["calls", "expiry", "operationCount"]);
  if (
    (r.validation !== "not-estimated" &&
      r.validation !== "estimated" &&
      r.validation !== "account-rejected") ||
    !grantId(r.grantId) ||
    r.chainId !== chainId ||
    !text(r.accountId, ID) ||
    !text(r.account, ADDRESS) ||
    r.signer !== "session" ||
    (r.route !== "bundler" && r.route !== "entrypoint-handleops") ||
    Object.values(e).some((x) => x !== "onchain") ||
    !integer(r.expiresAt, 1) ||
    !integer(r.validAfter) ||
    !integer(r.validUntil, r.validAfter + 1) ||
    !integer(r.perChainOperationLimit, 1, 0xffffffff) ||
    !Array.isArray(r.reasons) ||
    r.reasons.length > 10 ||
    r.reasons.some((x) => !REASONS.has(x)) ||
    !same(calls(r.calls), expected)
  )
    return fail("oaath_sdk_invalid");
  return r as unknown as Readonly<OaathCallsReview>;
}

export function readExecution(value: unknown): Readonly<OaathOperationExecution> {
  const r = record(capture(value), [
    "id",
    "grantId",
    "chainId",
    "sender",
    "calls",
    "transactionHash",
    "blockNumber",
    "blockHash",
    "outcome",
    "route",
  ]);
  if (
    (r.route !== null && r.route !== "bundler" && r.route !== "entrypoint-handleops") ||
    !text(r.id, HASH) ||
    !grantId(r.grantId) ||
    !integer(r.chainId, 1) ||
    !text(r.sender, ADDRESS) ||
    !text(r.transactionHash, HASH) ||
    !text(r.blockHash, HASH) ||
    !text(r.blockNumber, /^(0|[1-9][0-9]{0,77})$/) ||
    (r.outcome !== "success" && r.outcome !== "reverted")
  )
    return fail("oaath_sdk_invalid");
  calls(r.calls);
  return r as unknown as Readonly<OaathOperationExecution>;
}

export function readFallback(value: unknown): OaathCallsReview["fallback"] {
  if (value === null) return null;
  const r = record(value, ["route", "feePayer", "condition"]);
  if (
    r.route !== "entrypoint-handleops" ||
    r.condition !== "conclusive_bundler_rejection" ||
    !text(r.feePayer, ADDRESS)
  )
    return fail("oaath_sdk_invalid");
  return r as unknown as OaathCallsReview["fallback"];
}

function readSponsorshipReview(value: unknown): void {
  if (value === null) return;
  const r = record(value, ["url"]);
  if (typeof r.url !== "string" || r.url.length > 2048) fail("oaath_sdk_invalid");
}

export function readOwnerReview(
  value: unknown,
  chainId: number,
  expected: readonly DeploymentCall[],
): Readonly<OaathOwnerCallsReview> {
  const r = record(capture(value), [
    "chainId",
    "account",
    "kernelVersion",
    "calls",
    "signer",
    "route",
    "reasons",
    "paymasterService",
    "fallback",
    "capacity",
  ]);
  readFallback(r.fallback);
  readSponsorshipReview(r.paymasterService);
  const capacity = record(r.capacity, ["kind", "gas"]);
  const gas = record(capacity.gas, ["callGasLimit", "verificationGasLimit", "preVerificationGas"]);
  if (
    capacity.kind !== "single-operation" ||
    Object.values(gas).some(
      (value) => !text(value, /^(0|[1-9][0-9]{0,77})$/) || BigInt(value) >= 2n ** 256n,
    ) ||
    r.chainId !== chainId ||
    !text(r.account, ADDRESS) ||
    r.kernelVersion !== "0.3.3" ||
    r.signer !== "owner" ||
    r.route !== "bundler" ||
    !Array.isArray(r.reasons) ||
    r.reasons.length > 10 ||
    r.reasons.some((reason) => !REASONS.has(reason)) ||
    !same(calls(r.calls), expected)
  )
    return fail("oaath_sdk_invalid");
  return r as unknown as Readonly<OaathOwnerCallsReview>;
}

/** Optional SDK capabilities are captured once, without invoking accessors. */
export function optionalField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return fail("oaath_input_invalid");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) return fail("oaath_input_invalid");
  return descriptor.value;
}
