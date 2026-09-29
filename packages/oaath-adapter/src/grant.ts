import type {
  Oaath,
  OaathConnection,
  OaathGrantHandle,
  OaathRequestPermissionInput,
} from "@oaath/sdk";
import {
  compileExecutionOperations,
  type ExecutionPacking,
  type ExecutionProviderReview,
  parseReviewedPlan,
  type ReviewedPlan,
} from "moesi";
import { type BoundOAAthAccount, type OAAthAccountBinding, parseOAAthAccount } from "./account.js";
import {
  capture,
  fail,
  field,
  fingerprint,
  integer,
  method,
  OAAthAdapterError,
  operationLimit,
  optionalField,
  readReview,
} from "./boundary.js";

export interface OAAthPlanPermissionInput {
  /** One permission covers 1–32 distinct immutable plans, including heterogeneous fleet shards. */
  readonly plans: readonly ReviewedPlan[];
  readonly account?: OAAthAccountBinding;
  /** Defaults to one atomic operation per chain. */
  readonly packing?: ExecutionPacking;
  /** Grant lifetime in seconds; defaults to 30 minutes. */
  readonly expiresIn?: number;
  /** Defaults to the largest aggregate operation count on any one chain across all plans. */
  readonly perChainOperationLimit?: number;
}

function permissionInput(input: OAAthPlanPermissionInput) {
  const values = field(input, "plans");
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > 32 ||
    Reflect.ownKeys(values).length !== values.length + 1
  )
    return fail("oaath_input_invalid");
  const plans = Object.freeze(
    Array.from({ length: values.length }, (_, index) =>
      parseReviewedPlan(field(values, String(index)) as ReviewedPlan),
    ),
  );
  if (new Set(plans.map((plan) => plan.planId)).size !== plans.length)
    return fail("oaath_input_invalid");
  const account = parseOAAthAccount(optionalField(input, "account"));
  const packing = optionalField(input, "packing") ?? "per-chain";
  if (packing !== "per-chain" && packing !== "per-step") return fail("oaath_input_invalid");
  const counts = new Map<number, number>();
  let requiredAddress = account?.address;
  let requiredAccountId = account?.accountId;
  for (const plan of plans) {
    for (const requirement of plan.requirements) {
      const sender = requirement.sender;
      if (sender.kind === "reviewed-owner-eoa") return fail("oaath_sender_incompatible");
      if (sender.kind === "exact" || sender.kind === "logical-smart-account") {
        if (requiredAddress !== undefined && sender.address !== requiredAddress)
          return fail("oaath_sender_incompatible");
        requiredAddress = sender.address;
      }
      if (sender.kind === "logical-smart-account") {
        if (requiredAccountId !== undefined && sender.accountId !== requiredAccountId)
          return fail("oaath_sender_incompatible");
        requiredAccountId = sender.accountId;
      }
    }
    for (const operation of compileExecutionOperations(plan, packing))
      counts.set(operation.chainId, (counts.get(operation.chainId) ?? 0) + 1);
  }
  const count = Math.max(0, ...counts.values());
  const expiresIn = optionalField(input, "expiresIn") ?? 1800;
  const perChainOperationLimit = optionalField(input, "perChainOperationLimit") ?? count;
  if (
    count === 0 ||
    !integer(expiresIn, 1, 86400) ||
    !integer(perChainOperationLimit, count, 0xffffffff)
  )
    return fail("oaath_input_invalid");
  const union = new Map<
    string,
    { target: `0x${string}`; selectors: readonly `0x${string}`[]; valueLimit: string }
  >();
  for (const plan of plans)
    for (const requirement of plan.requirements)
      for (const call of requirement.calls) {
        if (call.data.length < 10) return fail("oaath_input_invalid");
        const selector = call.data.slice(0, 10) as `0x${string}`;
        const key = `${call.target}:${selector}`;
        const existing = union.get(key);
        if (!existing || BigInt(call.value) > BigInt(existing.valueLimit))
          union.set(key, { target: call.target, selectors: [selector], valueLimit: call.value });
      }
  if (union.size > 64) return fail("oaath_input_invalid");
  const request = capture({
    chainScope: "all",
    permissions: [
      {
        calls: [...union].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, call]) => call),
      },
    ],
    expiresIn,
    perChainOperationLimit,
  }) as Readonly<OaathRequestPermissionInput>;
  return { plans, account, packing: packing as ExecutionPacking, counts, request };
}
export function compileOAAthPlanPermission(
  input: OAAthPlanPermissionInput,
): Readonly<OaathRequestPermissionInput> {
  return permissionInput(input).request;
}

export type GrantPort = Pick<OaathGrantHandle, "reviewCalls" | "sendCalls" | "getOperation">;
export function grantPort(value: unknown): GrantPort {
  return Object.freeze({
    reviewCalls: method<OaathGrantHandle["reviewCalls"]>(value, "reviewCalls"),
    sendCalls: method<OaathGrantHandle["sendCalls"]>(value, "sendCalls"),
    getOperation: method<OaathGrantHandle["getOperation"]>(value, "getOperation"),
  });
}
export function connectionFactory(oaath: Oaath) {
  const connect = method<Oaath["connect"]>(oaath, "connect");
  return async () => {
    const value = await connect();
    return Object.freeze({
      resume: method<OaathConnection["resume"]>(value, "resume"),
      requestPermission: method<OaathConnection["requestPermission"]>(value, "requestPermission"),
      close: method<OaathConnection["close"]>(value, "close"),
    });
  };
}

export async function reviewGrant(
  plan: ReviewedPlan,
  packing: ExecutionPacking,
  grant: GrantPort,
  options: {
    readonly chainId?: number;
    readonly allowValidationRejection?: boolean;
    readonly account?: BoundOAAthAccount;
    readonly minimumOperations?: ReadonlyMap<number, number>;
    /** The configured execution lane, bound into the reviewed authority. */
    readonly lane?: Readonly<{ id: string; nonceKey: string }>;
  } = {},
): Promise<{
  review: ExecutionProviderReview;
  grantFingerprint: string;
  validationRejected: boolean;
}> {
  const chains: ExecutionProviderReview["chains"][number][] = [];
  const reasons: ExecutionProviderReview["reasons"][number][] = [];
  let grantFingerprint: string | undefined;
  let validationRejected = false;
  const operations = compileExecutionOperations(plan, packing);
  for (const requirement of plan.requirements.filter(
    (r) => options.chainId === undefined || r.chainId === options.chainId,
  )) {
    let chainReview: ExecutionProviderReview["chains"][number] | undefined;
    const chainOperations = operations.filter((op) => op.chainId === requirement.chainId);
    for (const operation of chainOperations) {
      const calls = operation.steps.map((step) => step.call);
      const fact = readReview(
        await grant.reviewCalls({ chain: requirement.chainId, calls }),
        requirement.chainId,
        calls,
      );
      if (
        operationLimit(fact) <
        (options.minimumOperations?.get(requirement.chainId) ?? chainOperations.length)
      )
        return fail("oaath_review_unavailable");
      const currentGrant = fingerprint(fact.grantId);
      if (grantFingerprint !== undefined && grantFingerprint !== currentGrant)
        return fail("oaath_sdk_invalid");
      grantFingerprint = currentGrant;
      const sender = requirement.sender;
      const accountId = options.account?.accountId ?? fact.accountId;
      const factAccount = fact.account.address;
      if (
        (options.account !== undefined && factAccount !== options.account.address) ||
        sender.kind === "reviewed-owner-eoa" ||
        (sender.kind === "exact" && sender.address !== factAccount) ||
        (sender.kind === "logical-smart-account" &&
          (sender.accountId !== accountId || sender.address !== factAccount))
      )
        return fail("oaath_sender_incompatible");
      if (options.allowValidationRejection && fact.validation === "not-estimated")
        return fail("oaath_review_unavailable");
      if (fact.validation === "account-rejected") {
        if (!options.allowValidationRejection) return fail("oaath_session_validation_failed");
        validationRejected = true;
      }
      const { calls: _calls, reasons: sdkReasons, validation: _validation, ...authority } = fact;
      const next = {
        chainId: requirement.chainId,
        sender: factAccount,
        accountId,
        route: `oaath-${fact.signer}-${fact.route}:${fingerprint(options.lane ? { authority, lane: options.lane } : authority)}`,
        signer: fact.signer,
        signerReason: "session-authorized",
        fallback: fact.fallback,
        enforcement: fact.enforcement,
      };
      if (chainReview && fingerprint(chainReview) !== fingerprint(next))
        return fail("oaath_review_changed");
      chainReview = next;
      for (const code of sdkReasons)
        if (!reasons.some((r) => r.chainId === requirement.chainId && r.code === `oaath_${code}`))
          reasons.push({ code: `oaath_${code}`, chainId: requirement.chainId, stepId: null });
    }
    if (chainReview) chains.push(chainReview);
  }
  if (grantFingerprint === undefined) return fail("oaath_input_invalid");
  return {
    review: capture({
      providerId: "oaath",
      status: "supported",
      chains,
      reasons,
    }) as ExecutionProviderReview,
    grantFingerprint,
    validationRejected,
  };
}

/** Explicit consent entry point. Never invoked by provider review, prepare, or observe. */
export async function requestOAAthPlanPermission(
  input: OAAthPlanPermissionInput & { readonly oaath: Oaath },
): Promise<Readonly<{ status: "requested" | "reused"; grantReference: string }>> {
  const parsed = permissionInput(input);
  const { request } = parsed;
  const connection = await connectionFactory(field(input, "oaath") as Oaath)().catch(() =>
    fail("oaath_permission_failed"),
  );
  try {
    const existing = await connection.resume();
    const grant = grantPort(existing ?? (await connection.requestPermission(request)));
    let grantReference: string | undefined;
    for (const plan of parsed.plans) {
      if (plan.requirements.length === 0) continue;
      const result = await reviewGrant(plan, parsed.packing, grant, {
        ...(parsed.account ? { account: parsed.account } : {}),
        minimumOperations: parsed.counts,
      }).catch((error) => {
        if (error instanceof OAAthAdapterError) throw error;
        return fail("oaath_review_unavailable");
      });
      if (grantReference !== undefined && grantReference !== result.grantFingerprint)
        return fail("oaath_review_changed");
      grantReference = result.grantFingerprint;
    }
    if (grantReference === undefined) return fail("oaath_input_invalid");
    return Object.freeze({
      status: existing === null ? "requested" : "reused",
      grantReference,
    });
  } catch (error) {
    if (error instanceof OAAthAdapterError) throw error;
    return fail("oaath_permission_failed");
  } finally {
    await connection.close().catch(() => {});
  }
}
