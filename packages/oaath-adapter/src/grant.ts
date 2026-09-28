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
import {
  capture,
  fail,
  fingerprint,
  integer,
  method,
  OAAthAdapterError,
  readReview,
} from "./boundary.js";

export interface OAAthPlanPermissionInput {
  readonly plan: ReviewedPlan;
  /** Defaults to one atomic operation per chain. */
  readonly packing?: ExecutionPacking;
  /** Grant lifetime in seconds; defaults to 30 minutes. */
  readonly expiresIn?: number;
  /** Defaults to the largest operation count on any one chain. */
  readonly perChainOperationLimit?: number;
}

export function compileOAAthPlanPermission(
  input: OAAthPlanPermissionInput,
): Readonly<OaathRequestPermissionInput> {
  const plan = parseReviewedPlan(input.plan);
  if (plan.requirements.some((r) => r.sender.kind === "reviewed-owner-eoa"))
    return fail("oaath_sender_incompatible");
  const operations = compileExecutionOperations(plan, input.packing ?? "per-chain");
  const count = Math.max(
    0,
    ...plan.requirements.map((r) => operations.filter((op) => op.chainId === r.chainId).length),
  );
  const expiresIn = input.expiresIn ?? 1800;
  const perChainOperationLimit = input.perChainOperationLimit ?? count;
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
  return capture({
    chainScope: "all",
    permissions: [
      {
        calls: [...union].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, call]) => call),
      },
    ],
    expiresIn,
    perChainOperationLimit,
  }) as Readonly<OaathRequestPermissionInput>;
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
  onlyChainId?: number,
): Promise<{ review: ExecutionProviderReview; grantFingerprint: string }> {
  const chains: ExecutionProviderReview["chains"][number][] = [];
  const reasons: ExecutionProviderReview["reasons"][number][] = [];
  let grantFingerprint: string | undefined;
  const operations = compileExecutionOperations(plan, packing);
  for (const requirement of plan.requirements.filter(
    (r) => onlyChainId === undefined || r.chainId === onlyChainId,
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
      if (fact.perChainOperationLimit < chainOperations.length)
        return fail("oaath_review_unavailable");
      const currentGrant = fingerprint(fact.grantId);
      if (grantFingerprint !== undefined && grantFingerprint !== currentGrant)
        return fail("oaath_sdk_invalid");
      grantFingerprint = currentGrant;
      const sender = requirement.sender;
      if (
        sender.kind === "reviewed-owner-eoa" ||
        (sender.kind === "exact" && sender.address !== fact.account) ||
        (sender.kind === "logical-smart-account" &&
          (sender.accountId !== fact.accountId || sender.address !== fact.account))
      )
        return fail("oaath_sender_incompatible");
      const { calls: _calls, reasons: sdkReasons, ...authority } = fact;
      const next = {
        chainId: requirement.chainId,
        sender: fact.account,
        accountId: fact.accountId,
        route: `oaath-${fact.signer}-${fact.route}:${fingerprint(authority)}`,
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
  };
}

/** Explicit consent entry point. Never invoked by provider review, prepare, or observe. */
export async function requestOAAthPlanPermission(
  input: OAAthPlanPermissionInput & { readonly oaath: Oaath },
): Promise<Readonly<{ status: "requested" | "reused"; grantReference: string }>> {
  const plan = parseReviewedPlan(input.plan);
  const request = compileOAAthPlanPermission(input);
  const connection = await connectionFactory(input.oaath)().catch(() =>
    fail("oaath_permission_failed"),
  );
  try {
    const existing = await connection.resume();
    const grant = grantPort(existing ?? (await connection.requestPermission(request)));
    const result = await reviewGrant(plan, input.packing ?? "per-chain", grant).catch((error) => {
      if (error instanceof OAAthAdapterError) throw error;
      return fail("oaath_review_unavailable");
    });
    return Object.freeze({
      status: existing === null ? "requested" : "reused",
      grantReference: result.grantFingerprint,
    });
  } catch (error) {
    if (error instanceof OAAthAdapterError) throw error;
    return fail("oaath_permission_failed");
  } finally {
    await connection.close().catch(() => {});
  }
}
