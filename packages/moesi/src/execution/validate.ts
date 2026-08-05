import type { Address, Hex } from "viem";
import { MoesiExecutionError } from "../errors.js";
import { mapArrayElements, snapshotArray } from "../internal.js";
import { MAX_PLAN_CHAINS, type ReviewedPlan } from "../planning/types.js";
import type { PreparedProviderExecution } from "./prepared.js";
import type { MoesiExecutionProvider } from "./provider.js";
import type {
  FinalizedProviderEvidence,
  ProviderExecutionEvidence,
  ProviderExecutionReference,
} from "./reference.js";
import {
  type ExecutionProviderChainReview,
  type ExecutionProviderReason,
  type ExecutionProviderReview,
  MOESI_EXECUTION_REVIEW_VERSION,
  type ReviewedExecution,
} from "./review.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/;
const REFERENCE_PATTERN = /^[a-zA-Z0-9:._-]{1,256}$/;
const ROUTE_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/;
const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/;
const STEP_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,382}[a-zA-Z0-9])?$/;
const UINT256_PATTERN = /^(?:0|[1-9][0-9]{0,77})$/;
const MAX_REASONS = 512;
const MAX_REVIEW_CHAINS = MAX_PLAN_CHAINS;
const MAX_UINT256 = (1n << 256n) - 1n;
const parsedProviders = new WeakMap<object, MoesiExecutionProvider>();

function fail(code: MoesiExecutionError["code"], message: string): never {
  throw new MoesiExecutionError(code, message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) snapshot[key] = Reflect.get(value, key);
    return snapshot;
  } catch {
    return null;
  }
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function snapshotBoundedArray(value: unknown, maximum: number): unknown[] | null {
  const snapshot = snapshotArray(value);
  return snapshot === null || snapshot.length > maximum ? null : snapshot;
}

/** Validates the provider capability shape at the Moesi trust boundary. */
export function parseExecutionProvider(input: unknown): MoesiExecutionProvider {
  try {
    const record = asRecord(input);
    if (record === null || !exactKeys(record, ["id", "review", "prepare", "submit", "observe"])) {
      fail("provider_invalid", "execution provider must be a plain record with the four methods");
    }
    const cached = parsedProviders.get(input as object);
    if (cached) return cached;
    const id = record.id;
    const review = record.review;
    const prepare = record.prepare;
    const submit = record.submit;
    const observe = record.observe;
    if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id)) {
      fail("provider_invalid", "execution provider id is invalid");
    }
    if (
      typeof review !== "function" ||
      typeof prepare !== "function" ||
      typeof submit !== "function" ||
      typeof observe !== "function"
    ) {
      fail("provider_invalid", "execution provider methods are invalid");
    }
    const reviewMethod = review as MoesiExecutionProvider["review"];
    const prepareMethod = prepare as MoesiExecutionProvider["prepare"];
    const submitMethod = submit as MoesiExecutionProvider["submit"];
    const observeMethod = observe as MoesiExecutionProvider["observe"];
    const provider: MoesiExecutionProvider = Object.freeze({
      id,
      review: (request: Parameters<MoesiExecutionProvider["review"]>[0]) =>
        Reflect.apply(reviewMethod, input, [request]) as ReturnType<typeof reviewMethod>,
      prepare: (request: Parameters<MoesiExecutionProvider["prepare"]>[0]) =>
        Reflect.apply(prepareMethod, input, [request]) as ReturnType<typeof prepareMethod>,
      submit: (request: Parameters<MoesiExecutionProvider["submit"]>[0]) =>
        Reflect.apply(submitMethod, input, [request]) as ReturnType<typeof submitMethod>,
      observe: (request: Parameters<MoesiExecutionProvider["observe"]>[0]) =>
        Reflect.apply(observeMethod, input, [request]) as ReturnType<typeof observeMethod>,
    });
    parsedProviders.set(input as object, provider);
    parsedProviders.set(provider, provider);
    return provider;
  } catch {
    throw new MoesiExecutionError("provider_invalid", "execution provider is invalid");
  }
}

function parseReason(value: unknown): ExecutionProviderReason | null {
  const record = asRecord(value);
  if (record === null || !exactKeys(record, ["code", "chainId", "stepId"])) return null;
  const code = record.code;
  const chainId = record.chainId;
  const stepId = record.stepId;
  if (typeof code !== "string" || !REFERENCE_PATTERN.test(code)) return null;
  if (
    chainId !== null &&
    (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0)
  ) {
    return null;
  }
  if (stepId !== null && (typeof stepId !== "string" || !STEP_ID_PATTERN.test(stepId))) {
    return null;
  }
  return {
    code,
    chainId: chainId as number | null,
    stepId: stepId as string | null,
  };
}

/**
 * Validates one provider review at the Moesi trust boundary into an immutable
 * representation. Throws `provider_review_invalid` on any contradiction.
 */
export function parseExecutionProviderReview(input: unknown): ExecutionProviderReview {
  try {
    return parseExecutionProviderReviewValue(input);
  } catch (error) {
    if (error instanceof MoesiExecutionError && error.code === "provider_review_invalid") {
      throw error;
    }
    return fail("provider_review_invalid", "provider review is invalid");
  }
}

function parseExecutionProviderReviewValue(input: unknown): ExecutionProviderReview {
  const record = asRecord(input);
  if (record === null || !exactKeys(record, ["providerId", "status", "chains", "reasons"])) {
    fail("provider_review_invalid", "provider review must be a plain record with exact keys");
  }
  const providerId = record.providerId;
  const status = record.status;
  const chainsValue = record.chains;
  const reasonsValue = record.reasons;
  if (typeof providerId !== "string" || !PROVIDER_ID_PATTERN.test(providerId)) {
    fail("provider_review_invalid", "provider review id is invalid");
  }
  if (status !== "supported" && status !== "blocked") {
    fail("provider_review_invalid", "provider review status is invalid");
  }
  const chainEntries = snapshotBoundedArray(chainsValue, MAX_REVIEW_CHAINS);
  if (chainEntries === null) {
    fail("provider_review_invalid", "provider review chains are invalid");
  }
  const seenChains = new Set<number>();
  const chains = mapArrayElements(chainEntries, (entry, index) => {
    const chain = parseChainReview(entry, index);
    if (seenChains.has(chain.chainId)) {
      fail("provider_review_invalid", "provider review repeats a chain");
    }
    seenChains.add(chain.chainId);
    return chain;
  });
  chains.sort((left, right) => left.chainId - right.chainId);
  const reasonEntries = snapshotBoundedArray(reasonsValue, MAX_REASONS);
  if (reasonEntries === null) {
    fail("provider_review_invalid", "provider review reasons are invalid");
  }
  const reasons = mapArrayElements(reasonEntries, (entry) => {
    const reason = parseReason(entry);
    if (reason === null) {
      fail("provider_review_invalid", "provider review reason is invalid");
    }
    return reason;
  });
  if (status === "blocked" && reasons.length === 0) {
    fail("provider_review_invalid", "a blocked provider review requires at least one reason");
  }
  return Object.freeze({
    providerId,
    status,
    chains: Object.freeze(chains),
    reasons: Object.freeze(reasons.map((reason) => Object.freeze(reason))),
  });
}

function parseChainReview(value: unknown, index: number): ExecutionProviderChainReview {
  const record = asRecord(value);
  if (
    record === null ||
    !exactKeys(record, ["chainId", "sender", "accountId", "route", "enforcement"])
  ) {
    return fail("provider_review_invalid", `provider chain review ${index} is invalid`);
  }
  const chainId = record.chainId;
  const sender = record.sender;
  const accountId = record.accountId;
  const route = record.route;
  const enforcementValue = record.enforcement;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return fail("provider_review_invalid", "provider chain review id is invalid");
  }
  if (sender !== null && (typeof sender !== "string" || !ADDRESS_PATTERN.test(sender))) {
    return fail("provider_review_invalid", "provider chain review sender is invalid");
  }
  if (
    accountId !== null &&
    (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId))
  ) {
    return fail("provider_review_invalid", "provider chain review account id is invalid");
  }
  if (typeof route !== "string" || !ROUTE_PATTERN.test(route)) {
    return fail("provider_review_invalid", "provider chain review route is invalid");
  }
  const enforcement = asRecord(enforcementValue);
  const calls = enforcement?.calls;
  const expiry = enforcement?.expiry;
  const operationCount = enforcement?.operationCount;
  if (
    enforcement === null ||
    !exactKeys(enforcement, ["calls", "expiry", "operationCount"]) ||
    !["onchain", "interactive-owner", "not-enforced"].includes(calls as string) ||
    !["onchain", "runtime", "not-enforced"].includes(expiry as string) ||
    !["onchain", "runtime", "not-enforced"].includes(operationCount as string)
  ) {
    return fail("provider_review_invalid", "provider chain review enforcement is invalid");
  }
  return Object.freeze({
    chainId,
    sender: sender === null ? null : (sender.toLowerCase() as Address),
    accountId,
    route,
    enforcement: Object.freeze({
      calls,
      expiry,
      operationCount,
    }) as ExecutionProviderChainReview["enforcement"],
  });
}

/**
 * Combines the provider-owned review with Moesi's own plan compatibility
 * checks. Provider status alone is never enough to satisfy sender or
 * enforcement requirements.
 */
export function validateProviderReviewForPlan(
  plan: ReviewedPlan,
  input: unknown,
): ExecutionProviderReview {
  const review = parseExecutionProviderReview(input);
  const reasons = [...review.reasons];
  let compatibilityBlocked = false;
  const addReason = (code: string, chainId: number): void => {
    compatibilityBlocked = true;
    if (
      reasons.length < MAX_REASONS &&
      !reasons.some((reason) => reason.code === code && reason.chainId === chainId)
    ) {
      reasons.push({ code, chainId, stepId: null });
    }
  };

  const requiredChains = new Set(plan.requirements.map(({ chainId }) => chainId));
  for (const chain of review.chains) {
    if (!requiredChains.has(chain.chainId)) {
      addReason("review-chain-unexpected", chain.chainId);
    }
  }
  for (const requirements of plan.requirements) {
    const chain = review.chains.find((candidate) => candidate.chainId === requirements.chainId);
    if (!chain) {
      addReason("review-chain-missing", requirements.chainId);
      continue;
    }
    const sender = requirements.sender;
    if (chain.sender === null) {
      addReason("review-sender-unavailable", requirements.chainId);
    } else if (
      (sender.kind === "exact" || sender.kind === "reviewed-owner-eoa") &&
      sender.address !== chain.sender
    ) {
      addReason("review-sender-mismatch", requirements.chainId);
    }
    if (sender.kind === "logical-smart-account" && sender.accountId !== chain.accountId) {
      addReason("review-account-mismatch", requirements.chainId);
    }

    if (
      requirements.enforcement.callScope === "required-onchain" &&
      chain.enforcement.calls !== "onchain"
    ) {
      addReason("review-call-enforcement-insufficient", requirements.chainId);
    } else if (
      requirements.enforcement.callScope === "interactive-review-sufficient" &&
      chain.enforcement.calls === "not-enforced"
    ) {
      addReason("review-call-enforcement-insufficient", requirements.chainId);
    }
    if (requirements.enforcement.expiry === "required" && chain.enforcement.expiry !== "onchain") {
      addReason("review-expiry-enforcement-insufficient", requirements.chainId);
    }
    if (
      requirements.enforcement.operationLimit === "required" &&
      chain.enforcement.operationCount !== "onchain"
    ) {
      addReason("review-operation-count-enforcement-insufficient", requirements.chainId);
    }
  }

  return Object.freeze({
    ...review,
    status: review.status === "blocked" || compatibilityBlocked ? "blocked" : "supported",
    reasons: Object.freeze(reasons.map((reason) => Object.freeze(reason))),
  });
}

/** Validates a Moesi-owned execution review at the apply boundary. */
export function parseReviewedExecution(input: unknown): ReviewedExecution {
  const record = asRecord(input);
  if (record === null || !exactKeys(record, ["version", "planId", "provider"])) {
    fail("provider_review_invalid", "reviewed execution must be a plain record with exact keys");
  }
  if (record.version !== MOESI_EXECUTION_REVIEW_VERSION) {
    fail("provider_review_invalid", "reviewed execution version is unsupported");
  }
  if (typeof record.planId !== "string" || !BYTES32_PATTERN.test(record.planId)) {
    fail("provider_review_invalid", "reviewed execution plan id is invalid");
  }
  return Object.freeze({
    version: MOESI_EXECUTION_REVIEW_VERSION,
    planId: record.planId.toLowerCase() as Hex,
    provider: parseExecutionProviderReview(record.provider),
  }) as ReviewedExecution;
}

/** Validates the prepared envelope a provider returns from `prepare`. */
export function parsePreparedProviderExecution(
  input: unknown,
  providerId: string,
  planId: Hex,
): PreparedProviderExecution {
  const record = asRecord(input);
  if (record === null || !exactKeys(record, ["providerId", "planId", "binding"])) {
    fail("provider_mismatch", "prepared execution must be a plain record with exact keys");
  }
  if (record.providerId !== providerId) {
    fail("provider_mismatch", "prepared execution provider does not match the selected provider");
  }
  if (record.planId !== planId) {
    fail("plan_mismatch", "prepared execution plan does not match the reviewed plan");
  }
  return Object.freeze({ providerId, planId, binding: record.binding });
}

/** Validates the durable provider reference a provider returns from `submit`. */
export function parseProviderExecutionReference(
  input: unknown,
  providerId: string,
  chainId: number,
): ProviderExecutionReference {
  const record = asRecord(input);
  if (record === null || !exactKeys(record, ["providerId", "chainId", "reference"])) {
    return fail("provider_mismatch", "provider reference must be a plain record with exact keys");
  }
  const referenceProviderId = record.providerId;
  const referenceChainId = record.chainId;
  const reference = record.reference;
  if (referenceProviderId !== providerId || referenceChainId !== chainId) {
    fail("provider_mismatch", "provider reference contradicts the submitted action");
  }
  if (typeof reference !== "string" || !REFERENCE_PATTERN.test(reference)) {
    fail("provider_mismatch", "provider reference identity is invalid");
  }
  return Object.freeze({
    providerId,
    chainId,
    reference,
  });
}

function parseFinalizedEvidence(value: unknown): FinalizedProviderEvidence | null {
  const record = asRecord(value);
  if (
    record === null ||
    !exactKeys(record, [
      "chainId",
      "sender",
      "calls",
      "providerEvidenceId",
      "blockNumber",
      "blockHash",
    ])
  ) {
    return null;
  }
  if (
    typeof record.chainId !== "number" ||
    !Number.isSafeInteger(record.chainId) ||
    record.chainId <= 0
  ) {
    return null;
  }
  if (typeof record.sender !== "string" || !ADDRESS_PATTERN.test(record.sender)) return null;
  if (
    typeof record.providerEvidenceId !== "string" ||
    !BYTES32_PATTERN.test(record.providerEvidenceId)
  ) {
    return null;
  }
  if (
    typeof record.blockNumber !== "string" ||
    !UINT256_PATTERN.test(record.blockNumber) ||
    BigInt(record.blockNumber) > MAX_UINT256
  ) {
    return null;
  }
  if (typeof record.blockHash !== "string" || !BYTES32_PATTERN.test(record.blockHash)) return null;
  const callEntries = snapshotBoundedArray(record.calls, MAX_REASONS);
  if (callEntries === null || callEntries.length === 0) return null;
  const calls = mapArrayElements(callEntries, (call) => {
    const callRecord = asRecord(call);
    if (callRecord === null || !exactKeys(callRecord, ["target", "data", "value"])) return null;
    if (typeof callRecord.target !== "string" || !ADDRESS_PATTERN.test(callRecord.target)) {
      return null;
    }
    if (typeof callRecord.data !== "string" || !HEX_PATTERN.test(callRecord.data)) return null;
    if (
      typeof callRecord.value !== "string" ||
      !UINT256_PATTERN.test(callRecord.value) ||
      BigInt(callRecord.value) > MAX_UINT256
    ) {
      return null;
    }
    return Object.freeze({
      target: callRecord.target.toLowerCase() as Address,
      data: callRecord.data.toLowerCase() as Hex,
      value: callRecord.value,
    });
  });
  if (calls.some((call) => call === null)) return null;
  return Object.freeze({
    chainId: record.chainId,
    sender: record.sender.toLowerCase() as Address,
    calls: Object.freeze(calls as readonly { target: Address; data: Hex; value: string }[]),
    providerEvidenceId: record.providerEvidenceId.toLowerCase() as Hex,
    blockNumber: record.blockNumber,
    blockHash: record.blockHash.toLowerCase() as Hex,
  });
}

/**
 * Validates one provider observation at the Moesi trust boundary. Malformed
 * evidence fails closed: it is reported as `invalid-evidence`, never as
 * pending or absent.
 */
export function parseProviderExecutionEvidence(input: unknown): ProviderExecutionEvidence {
  try {
    return parseProviderExecutionEvidenceValue(input);
  } catch {
    return { status: "unreadable", reason: "invalid-evidence" };
  }
}

function parseProviderExecutionEvidenceValue(input: unknown): ProviderExecutionEvidence {
  const record = asRecord(input);
  if (record === null || typeof record.status !== "string") {
    return { status: "unreadable", reason: "invalid-evidence" };
  }
  if (record.status === "finalized") {
    if (!exactKeys(record, ["status", "finalized"])) {
      return { status: "unreadable", reason: "invalid-evidence" };
    }
    const finalized = parseFinalizedEvidence(record.finalized);
    if (finalized === null) return { status: "unreadable", reason: "invalid-evidence" };
    return { status: "finalized", finalized };
  }
  if (record.status === "failed") {
    if (
      !exactKeys(record, ["status", "reason"]) ||
      typeof record.reason !== "string" ||
      !REFERENCE_PATTERN.test(record.reason)
    ) {
      return { status: "unreadable", reason: "invalid-evidence" };
    }
    return { status: "failed", reason: record.reason };
  }
  if (record.status === "pending") {
    if (!exactKeys(record, ["status"])) return { status: "unreadable", reason: "invalid-evidence" };
    return { status: "pending" };
  }
  if (record.status === "unreadable") {
    if (
      !exactKeys(record, ["status", "reason"]) ||
      (record.reason !== "observation-unavailable" && record.reason !== "invalid-evidence")
    ) {
      return { status: "unreadable", reason: "invalid-evidence" };
    }
    return { status: "unreadable", reason: record.reason };
  }
  return { status: "unreadable", reason: "invalid-evidence" };
}
