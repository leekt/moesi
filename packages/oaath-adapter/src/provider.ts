import type {
  Oaath,
  OaathOperationHandle,
  OaathOperationLane,
  OaathOwnerAccount,
  OaathOwnerClient,
  OaathOwnerHandle,
  OaathOwnerKey,
  OaathPayer,
} from "@oaath/sdk";
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
import { type OAAthAccountBinding, parseOAAthAccount } from "./account.js";
import {
  capture,
  fail,
  field,
  fingerprint,
  HASH,
  method,
  OAAthAdapterError,
  optionalField,
  readExecution,
  readOwnerReview,
  record,
  same,
  text,
} from "./boundary.js";
import { compileOAAthPlanPermission, connectionFactory, grantPort, reviewGrant } from "./grant.js";

const REFERENCE =
  /^oaath-op-v3:(session|owner):([0-9a-f]{64}|0x[0-9a-f]{40}):(default|lane\.([1-9][0-9]{0,19})\.([A-Za-z0-9_-]{1,32})):(0x[0-9a-f]{64})$/;
const LANE_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface OAAthExecutionProviderInput {
  readonly oaath: Oaath | OaathOwnerClient;
  /** Existing smart-account identity; the SDK verifies the deployed account and root owner. */
  readonly account?: OAAthAccountBinding;
  /** The account's root owner key: a connected wallet or any SDK signing profile. */
  readonly owner?: OaathOwnerKey;
  /**
   * Auto chooses owner for one-operation chains or conclusive session-validation failure.
   * `session` needs a connectable client; `owner` needs an owner client and `account`.
   */
  readonly signer?: "auto" | "owner" | "session";
  /**
   * Who pays gas, forwarded unchanged to every SDK review and send. Omitted: the
   * chain's configured OAAth submission routes decide. Submission routing stays OAAth's.
   */
  readonly payer?: OaathPayer;
  /**
   * An independent caller-reserved session lane, forwarded unchanged to every send,
   * so an unresolved run on another lane does not block this one. Session signing
   * only; the lane is bound into the review and retained in each reference, so
   * recovery needs no lane configuration. Omitted: the default lane.
   */
  readonly lane?: OaathOperationLane;
}

function parseLane(value: unknown): Readonly<OaathOperationLane> | undefined {
  if (value === undefined) return undefined;
  const id = optionalField(value, "id");
  const nonceKey = optionalField(value, "nonceKey");
  if (
    Object.keys(value as object).length !== 2 ||
    !text(id, LANE_ID) ||
    typeof nonceKey !== "bigint" ||
    nonceKey < 1n ||
    nonceKey >= 2n ** 64n
  )
    return fail("oaath_input_invalid");
  return Object.freeze({ id, nonceKey });
}

function parsePayer(value: unknown): Readonly<OaathPayer> | undefined {
  if (value === undefined) return undefined;
  const kind = optionalField(value, "kind");
  if (kind === "connected-eoa") {
    const wallet = optionalField(value, "wallet");
    if (!wallet || typeof wallet !== "object" || Object.keys(value as object).length !== 2)
      return fail("oaath_input_invalid");
    return Object.freeze({ kind, wallet }) as Readonly<OaathPayer>;
  }
  if (kind === "paymaster-service") {
    try {
      return capture(value) as Readonly<OaathPayer>;
    } catch {
      return fail("oaath_input_invalid");
    }
  }
  return fail("oaath_input_invalid");
}

interface ChainExecution {
  readonly kind: "session" | "owner";
  readonly context: string;
  readonly send: (input: {
    chain: number;
    calls: ReviewedPlan["requirements"][number]["calls"];
  }) => Promise<unknown>;
}
interface Binding {
  readonly plan: ReviewedPlan;
  readonly review: ExecutionProviderReview;
  readonly packing: ExecutionPacking;
  readonly attempted: Set<string>;
}

export function createOAAthExecutionProvider(
  input: OAAthExecutionProviderInput,
): MoesiExecutionProvider {
  const client = field(input, "oaath") as OAAthExecutionProviderInput["oaath"];
  const OPTIONS = ["oaath", "account", "owner", "signer", "payer", "lane"];
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !OPTIONS.includes(key)))
    return fail("oaath_input_invalid");
  const signerInput = optionalField(input, "signer");
  const signer = signerInput === undefined ? "auto" : signerInput;
  if (!["auto", "owner", "session"].includes(signer as string)) return fail("oaath_input_invalid");
  const wallet = optionalField(input, "owner") as OAAthExecutionProviderInput["owner"];
  const payer = parsePayer(optionalField(input, "payer"));
  const lane = parseLane(optionalField(input, "lane"));
  const laneKey = lane && Object.freeze({ id: lane.id, nonceKey: lane.nonceKey.toString() });
  const laneSegment = laneKey ? `lane.${laneKey.nonceKey}.${laneKey.id}` : "default";
  const account = parseOAAthAccount(optionalField(input, "account"));
  const connect =
    optionalField(client, "connect") === undefined ? undefined : connectionFactory(client as Oaath);
  const accountFactory =
    optionalField(client, "account") === undefined
      ? undefined
      : method<OaathOwnerClient["account"]>(client, "account");
  if (!connect && !accountFactory) return fail("oaath_input_invalid");
  if (wallet !== undefined && account === undefined) return fail("oaath_input_invalid");
  // An explicit signer must be reachable; an absent wallet stays valid for recovery.
  if (signer === "session" && !connect) return fail("oaath_input_invalid");
  if (signer === "owner" && (!accountFactory || account === undefined))
    return fail("oaath_input_invalid");
  // Lanes are Grant session sequences; owner execution has no lane.
  if (lane && (signer === "owner" || !connect)) return fail("oaath_input_invalid");
  let ownerAccount: Readonly<OaathOwnerAccount> | undefined;
  let ownerHandle: Readonly<OaathOwnerHandle> | undefined;
  if (account !== undefined && accountFactory !== undefined) {
    ownerAccount = accountFactory(account.address);
    if (field(ownerAccount, "address") !== account.address) return fail("oaath_sdk_invalid");
    if (wallet !== undefined)
      ownerHandle = method<OaathOwnerAccount["owner"]>(ownerAccount, "owner")(wallet);
  }
  const extra = payer === undefined ? {} : { payer };
  let connection: ReturnType<NonNullable<typeof connect>> | undefined;
  const bindings = new WeakMap<object, Binding>();
  async function currentGrant(estimate = false) {
    if (!connect) return fail("oaath_grant_required");
    connection ??= connect();
    const value = await (await connection).resume();
    if (value === null) return fail("oaath_grant_required");
    const grant = grantPort(value);
    return {
      reviewCalls: (request: unknown) =>
        grant.reviewCalls({
          ...(request as object),
          ...extra,
          ...(estimate ? { estimate: true } : {}),
        }),
      sendCalls: (request: unknown) =>
        grant.sendCalls({ ...(request as object), ...extra, ...(lane ? { lane } : {}) }),
      getOperation: grant.getOperation,
    };
  }
  async function currentReview(
    plan: ReviewedPlan,
    packing: ExecutionPacking,
    onlyChainId?: number,
  ) {
    const executions = new Map<number, ChainExecution>();
    const chains: ExecutionProviderReview["chains"][number][] = [];
    const reasons: ExecutionProviderReview["reasons"][number][] = [];
    const operations = compileExecutionOperations(plan, packing);
    for (const requirement of plan.requirements.filter(
      (r) => onlyChainId === undefined || r.chainId === onlyChainId,
    )) {
      const units = operations.filter((op) => op.chainId === requirement.chainId);
      const requiresOnchain = Object.values(requirement.enforcement).some(
        (value) => value === "required" || value === "required-onchain",
      );
      const chooseOwner =
        signer === "owner" ||
        (signer === "auto" &&
          !lane &&
          ownerHandle !== undefined &&
          units.length === 1 &&
          !requiresOnchain);
      let rejectedSession: ExecutionProviderReview | undefined;
      if (!chooseOwner) {
        compileOAAthPlanPermission({ plans: [plan], packing });
        const canFallback =
          signer === "auto" && !lane && ownerHandle !== undefined && !requiresOnchain;
        const grant = await currentGrant(canFallback);
        const selected = await reviewGrant(plan, packing, grant, {
          chainId: requirement.chainId,
          allowValidationRejection: canFallback,
          ...(account ? { account } : {}),
          ...(laneKey ? { lane: laneKey } : {}),
        });
        if (account && selected.review.chains.some((chain) => chain.sender !== account.address))
          return fail("oaath_sender_incompatible");
        if (!selected.validationRejected) {
          chains.push(...selected.review.chains);
          reasons.push(...selected.review.reasons);
          executions.set(requirement.chainId, {
            kind: "session",
            context: selected.grantFingerprint,
            send: grant.sendCalls,
          });
          continue;
        }
        rejectedSession = selected.review;
      }
      if (!ownerHandle || !account) return fail("oaath_owner_required");
      if (
        requirement.sender.kind === "reviewed-owner-eoa" ||
        (requirement.sender.kind === "exact" && requirement.sender.address !== account.address) ||
        (requirement.sender.kind === "logical-smart-account" &&
          (requirement.sender.address !== account.address ||
            requirement.sender.accountId !== account.accountId))
      )
        return fail("oaath_sender_incompatible");
      const reviewCalls = method<OaathOwnerHandle["reviewCalls"]>(ownerHandle, "reviewCalls");
      let authority: unknown;
      let first: ReturnType<typeof readOwnerReview> | undefined;
      for (const unit of units) {
        const calls = unit.steps.map((step) => step.call);
        const fact = readOwnerReview(
          await reviewCalls({ chain: requirement.chainId, calls, ...extra }),
          requirement.chainId,
          calls,
        );
        if (fact.account.address !== account.address) return fail("oaath_sender_incompatible");
        const { calls: _calls, capacity: _capacity, ...binding } = fact;
        if (authority !== undefined && !same(authority, binding))
          return fail("oaath_review_changed");
        authority = binding;
        first = fact;
      }
      if (!first) return fail("oaath_input_invalid");
      chains.push({
        chainId: requirement.chainId,
        sender: account.address,
        accountId: account.accountId,
        route: `oaath-owner-${first.route}:${fingerprint(rejectedSession ? { owner: authority, rejectedSession } : authority)}`,
        signer: "owner",
        signerReason: rejectedSession
          ? "session-validation-failed"
          : signer === "auto"
            ? "plan-fits-one-operation"
            : "owner-selected",
        fallback: first.fallback,
        enforcement: {
          calls: "interactive-owner",
          expiry: "not-enforced",
          operationCount: "not-enforced",
        },
      });
      for (const code of first.reasons)
        reasons.push({ code: `oaath_${code}`, chainId: requirement.chainId, stepId: null });
      const send = method<OaathOwnerHandle["sendCalls"]>(ownerHandle, "sendCalls");
      executions.set(requirement.chainId, {
        kind: "owner",
        context: account.address,
        send: (request) => send({ ...request, ...extra }),
      });
    }
    return {
      review: capture({
        providerId: "oaath",
        status: "supported",
        chains,
        reasons,
      }) as ExecutionProviderReview,
      executions,
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
            fallback: null,
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
        const kind = parsed[1];
        const context = parsed[2];
        const operationId = parsed[6];
        const retainedLane =
          parsed[4] === undefined || parsed[5] === undefined
            ? undefined
            : Object.freeze({ id: parsed[5], nonceKey: BigInt(parsed[4]) });
        let operation: unknown;
        if (kind === "owner") {
          if (!account || !ownerAccount || context !== account.address || retainedLane)
            return { status: "unreadable", reason: "invalid-evidence" };
          operation = await method<OaathOwnerAccount["getOperation"]>(
            ownerAccount,
            "getOperation",
          )({ chain: reference.chainId, id: operationId });
        } else {
          if (!context || !/^[0-9a-f]{64}$/.test(context))
            return { status: "unreadable", reason: "invalid-evidence" };
          operation = await (await currentGrant()).getOperation({
            chain: reference.chainId,
            id: operationId,
            ...(retainedLane ? { lane: retainedLane } : {}),
          });
        }
        if (operation === null) return { status: "unreadable", reason: "observation-unavailable" };
        if (
          field(operation, "id") !== operationId ||
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
          facts.id !== operationId ||
          (kind === "session"
            ? fingerprint(facts.grantId) !== context
            : facts.sender !== context) ||
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
            submissionRoute: facts.route,
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
      const selected = latest.executions.get(operation.chainId);
      if (!selected) return fail("oaath_action_invalid");
      const sent = await selected.send({
        chain: operation.chainId,
        calls: operation.steps.map((step) => step.call),
      });
      const id = field(sent, "id");
      if (!text(id, HASH) || field(sent, "chainId") !== operation.chainId)
        return fail("oaath_sdk_invalid");
      return Object.freeze({
        providerId: "oaath",
        chainId: operation.chainId,
        reference: `oaath-op-v3:${selected.kind}:${selected.context}:${selected.kind === "session" ? laneSegment : "default"}:${id}`,
      });
    } catch (error) {
      if (error instanceof OAAthAdapterError) throw error;
      return fail("oaath_submission_failed");
    }
  }
  return Object.freeze(provider);
}
