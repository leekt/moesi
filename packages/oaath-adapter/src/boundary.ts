import {
  type OaathCallsReview,
  type OaathCallsReviewContract,
  type OaathOperationExecution,
  type OaathOwnerCallsReview,
  parseOaathCallsReview,
} from "@oaath/sdk";
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
/** Semantic signer reasons; route reasons name an opaque route kind. */
const SIGNER_REASONS = new Set([
  "owner_explicit",
  "owner_auto_single_operation",
  "session_auto_owner_unavailable",
  "session_auto_multiple_operations",
  "root_operation_requires_owner",
  "session_covers_calls",
  "session_calls_uncovered",
  "session_coverage_unreadable",
]);
const ROUTE_REASON =
  /^route_(?:available|absent|unsupported|unreadable):[a-z0-9][a-z0-9._-]{0,39}$/;
/** Opaque identity: bounded and well-formed, fingerprinted, never enumerated. */
const IDENTITY = /^[a-z0-9](?:[a-z0-9._:-]{0,62}[a-z0-9])?$/;
/** Opaque route kind; short enough to embed in Moesi's bounded route string. */
const ROUTE = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;

function reasons(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 10 ||
    value.some(
      (reason) =>
        typeof reason !== "string" ||
        !(
          SIGNER_REASONS.has(reason) ||
          ROUTE_REASON.test(reason) ||
          reason === "route_none_configured"
        ),
    )
  )
    return fail("oaath_sdk_invalid");
  return value;
}

/** The versioned SDK contract, validated by the SDK and then narrowed to what Moesi acts on. */
function readContract(
  value: Record<string, unknown>,
  chainId: number,
  expected: readonly DeploymentCall[],
): Readonly<OaathCallsReviewContract> {
  let contract: Readonly<OaathCallsReviewContract>;
  try {
    contract = parseOaathCallsReview(value);
  } catch {
    return fail("oaath_sdk_invalid");
  }
  if (
    contract.chainId !== chainId ||
    !text(contract.account.address, ADDRESS) ||
    !text(contract.account.implementation, IDENTITY) ||
    !text(contract.route, ROUTE) ||
    !same(calls(value.calls), expected)
  )
    return fail("oaath_sdk_invalid");
  readFallback(value.fallback);
  readSponsorshipReview(value.paymasterService);
  reasons(value.reasons);
  return contract;
}

export function readReview(
  value: unknown,
  chainId: number,
  expected: readonly DeploymentCall[],
): Readonly<OaathCallsReview & { signer: "session" }> {
  const r = capture(value) as Record<string, unknown>;
  if (!r || typeof r !== "object" || Array.isArray(r)) return fail("oaath_sdk_invalid");
  const contract = readContract(r, chainId, expected);
  const limit = r.perChainOperationLimit;
  if (
    contract.signer !== "session" ||
    Object.values(contract.enforcement).some((x) => x !== "onchain") ||
    (r.enableVerificationGasFloor !== null &&
      !text(r.enableVerificationGasFloor, /^(0|[1-9][0-9]{0,38})$/)) ||
    !grantId(r.grantId) ||
    !text(r.accountId, ID) ||
    !integer(r.expiresAt, 1) ||
    !integer(r.validAfter) ||
    !integer(r.validUntil, (r.validAfter as number) + 1) ||
    !limit ||
    typeof limit !== "object" ||
    Object.keys(limit).sort().join(",") !== "count,intervalSeconds" ||
    !integer((limit as { count: unknown }).count, 1, 0xffffffff) ||
    ((limit as { intervalSeconds: unknown }).intervalSeconds !== null &&
      !integer((limit as { intervalSeconds: unknown }).intervalSeconds, 1))
  )
    return fail("oaath_sdk_invalid");
  return r as unknown as Readonly<OaathCallsReview & { signer: "session" }>;
}

/** Operations one chain may validate; a windowed limit is conservatively its per-window count. */
export function operationLimit(fact: Readonly<OaathCallsReview & { signer: "session" }>): number {
  return fact.perChainOperationLimit.count;
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
    (r.route !== null && !text(r.route, ROUTE)) ||
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
    !text(r.route, ROUTE) ||
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
  const r = capture(value) as Record<string, unknown>;
  if (!r || typeof r !== "object" || Array.isArray(r)) return fail("oaath_sdk_invalid");
  const contract = readContract(r, chainId, expected);
  // `capacity.detail` is transport-specific and outside the contract.
  const capacity = r.capacity as { kind?: unknown } | null;
  if (
    contract.signer !== "owner" ||
    contract.validation !== "estimated" ||
    Object.values(contract.enforcement).some((x) => x !== "none") ||
    !capacity ||
    typeof capacity !== "object" ||
    capacity.kind !== "single-operation"
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
