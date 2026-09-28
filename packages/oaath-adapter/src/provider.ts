import type { Oaath, OaathOperationHandle } from "@oaath/sdk";
import {
  compileExecutionOperations,
  type ExecutionPacking,
  type ExecutionProviderReview,
  type MoesiExecutionProvider,
  type PreparedProviderExecution,
  parseReviewedPlan,
  type ReviewedPlan,
  type ReviewedPlanOperation,
} from "moesi";
import {
  capture,
  fail,
  field,
  fingerprint,
  HASH,
  method,
  OAAthAdapterError,
  readExecution,
  record,
  same,
  text,
} from "./boundary.js";
import { compileOAAthPlanPermission, connectionFactory, grantPort, reviewGrant } from "./grant.js";

const REFERENCE = /^oaath-op-v1:([0-9a-f]{64}):(0x[0-9a-f]{64})$/;
interface Binding {
  readonly plan: ReviewedPlan;
  readonly review: ExecutionProviderReview;
  readonly packing: ExecutionPacking;
  readonly attempted: Set<string>;
}

export function createOAAthExecutionProvider(input: {
  readonly oaath: Oaath;
}): MoesiExecutionProvider {
  const connect = connectionFactory(input.oaath);
  let connection: ReturnType<typeof connect> | undefined;
  const bindings = new WeakMap<object, Binding>();
  async function currentGrant() {
    connection ??= connect();
    const value = await (await connection).resume();
    if (value === null) return fail("oaath_grant_required");
    return grantPort(value);
  }
  async function currentReview(plan: ReviewedPlan, packing: ExecutionPacking, chainId?: number) {
    compileOAAthPlanPermission({ plan, packing });
    const grant = await currentGrant();
    return {
      ...(await reviewGrant(plan, packing, grant, chainId)),
      grant,
    };
  }
  const provider: MoesiExecutionProvider = {
    id: "oaath",
    async review({ plan: inputPlan, packing }) {
      const plan = parseReviewedPlan(inputPlan);
      if (plan.requirements.length === 0)
        return Object.freeze({
          providerId: "oaath",
          status: "supported",
          chains: Object.freeze([]),
          reasons: Object.freeze([]),
        });
      try {
        return (await currentReview(plan, packing)).review;
      } catch (error) {
        const code = error instanceof OAAthAdapterError ? error.code : "oaath_review_unavailable";
        return capture({
          providerId: "oaath",
          status: "blocked",
          chains: plan.requirements.map((r) => ({
            chainId: r.chainId,
            sender: null,
            accountId: null,
            route: "oaath-unavailable",
            signer: "unavailable",
            signerReason: code,
            enforcement: {
              calls: "not-enforced",
              expiry: "not-enforced",
              operationCount: "not-enforced",
            },
          })),
          reasons: [{ code, chainId: null, stepId: null }],
        }) as ExecutionProviderReview;
      }
    },
    async prepare({ plan: inputPlan, review, packing }) {
      const plan = parseReviewedPlan(inputPlan);
      const ownedReview = capture(review) as ExecutionProviderReview;
      const latest = await provider.review({ plan, packing });
      if (latest.status !== "supported" || !same(latest, ownedReview))
        return fail("oaath_review_changed");
      const binding = Object.freeze({});
      bindings.set(binding, { plan, review: ownedReview, packing, attempted: new Set() });
      return Object.freeze({ providerId: "oaath", planId: plan.planId, binding });
    },
    async submit({ prepared, action: inputAction }) {
      const bound = boundExecution(prepared);
      if (bound.packing !== "per-step") return fail("oaath_action_invalid");
      const action = record(capture(inputAction), ["planId", "chainId", "step"]);
      const operation = compileExecutionOperations(bound.plan, bound.packing).find(
        (op) =>
          op.planId === action.planId &&
          op.chainId === action.chainId &&
          same(op.steps[0], action.step),
      );
      if (!operation) return fail("oaath_action_invalid");
      return submitOperation(prepared, operation, "per-step");
    },
    async submitBatch({ prepared, operation }) {
      return submitOperation(prepared, operation, "per-chain");
    },
    async observe({ reference: inputReference }) {
      try {
        const reference = record(capture(inputReference), ["providerId", "chainId", "reference"]);
        const parsed =
          typeof reference.reference === "string" ? REFERENCE.exec(reference.reference) : null;
        if (
          reference.providerId !== "oaath" ||
          !parsed ||
          typeof reference.chainId !== "number" ||
          reference.chainId < 1
        )
          return { status: "unreadable", reason: "invalid-evidence" };
        const grant = await currentGrant();
        const operation = await grant.getOperation({ chain: reference.chainId, id: parsed[2] });
        if (operation === null) return { status: "unreadable", reason: "observation-unavailable" };
        if (
          field(operation, "id") !== parsed[2] ||
          field(operation, "chainId") !== reference.chainId
        )
          return { status: "unreadable", reason: "invalid-evidence" };
        const observe = method<OaathOperationHandle["observe"]>(operation, "observe");
        const execution = method<OaathOperationHandle["execution"]>(operation, "execution");
        const status = field(await observe(), "status");
        if (status === "pending") return Object.freeze({ status: "pending" });
        if (status === "unreadable")
          return { status: "unreadable", reason: "observation-unavailable" };
        if (status === "dropped" || status === "superseded" || status === "abandoned")
          return Object.freeze({ status: "failed", reason: `oaath_${status}` });
        if (status !== "finalized") return { status: "unreadable", reason: "invalid-evidence" };
        const facts = readExecution(await execution());
        if (
          facts.id !== parsed[2] ||
          fingerprint(facts.grantId) !== parsed[1] ||
          facts.chainId !== reference.chainId
        )
          return { status: "unreadable", reason: "invalid-evidence" };
        if (facts.outcome === "reverted")
          return Object.freeze({ status: "failed", reason: "oaath_reverted" });
        return Object.freeze({
          status: "finalized",
          finalized: Object.freeze({
            chainId: facts.chainId,
            sender: facts.sender,
            calls: facts.calls,
            providerEvidenceId: facts.transactionHash,
            blockNumber: facts.blockNumber,
            blockHash: facts.blockHash,
          }),
        });
      } catch (error) {
        return Object.freeze({
          status: "unreadable",
          reason:
            error instanceof OAAthAdapterError && error.code === "oaath_sdk_invalid"
              ? "invalid-evidence"
              : "observation-unavailable",
        });
      }
    },
  };

  function boundExecution(prepared: PreparedProviderExecution): Binding {
    const binding = field(prepared, "binding");
    const bound = binding && typeof binding === "object" ? bindings.get(binding) : undefined;
    if (
      !bound ||
      field(prepared, "providerId") !== "oaath" ||
      field(prepared, "planId") !== bound.plan.planId
    )
      return fail("oaath_action_invalid");
    return bound;
  }
  async function submitOperation(
    prepared: PreparedProviderExecution,
    inputOperation: ReviewedPlanOperation,
    packing: ExecutionPacking,
  ) {
    const bound = boundExecution(prepared);
    if (packing !== bound.packing) return fail("oaath_action_invalid");
    const candidate = capture(inputOperation);
    const operation = compileExecutionOperations(bound.plan, packing).find((op) =>
      same(op, candidate),
    );
    if (!operation) return fail("oaath_action_invalid");
    const key = `${operation.chainId}:${operation.id}`;
    if (bound.attempted.has(key)) return fail("oaath_action_invalid");
    // Reserve the whole unit before any await; ambiguous failures never permit resend.
    bound.attempted.add(key);
    try {
      const latest = await currentReview(bound.plan, packing, operation.chainId);
      const accepted = {
        ...bound.review,
        chains: bound.review.chains.filter((c) => c.chainId === operation.chainId),
        reasons: bound.review.reasons.filter(
          (r) => r.chainId === operation.chainId || r.chainId === null,
        ),
      };
      if (!same(latest.review, accepted)) return fail("oaath_review_changed");
      const sent = await latest.grant.sendCalls({
        chain: operation.chainId,
        calls: operation.steps.map((step) => step.call),
      });
      const id = field(sent, "id");
      if (!text(id, HASH) || field(sent, "chainId") !== operation.chainId)
        return fail("oaath_sdk_invalid");
      return Object.freeze({
        providerId: "oaath",
        chainId: operation.chainId,
        reference: `oaath-op-v1:${latest.grantFingerprint}:${id}`,
      });
    } catch (error) {
      if (error instanceof OAAthAdapterError) throw error;
      return fail("oaath_submission_failed");
    }
  }
  return Object.freeze(provider);
}
