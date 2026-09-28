import type {
  Oaath,
  OaathConnectedEoaFeePayer,
  OaathOperationHandle,
  OaathOwnerAccount,
  OaathOwnerClient,
  OaathOwnerHandle,
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
import type { Address } from "viem";
import {
  capture,
  fail,
  field,
  fingerprint,
  HASH,
  ID,
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

const REFERENCE = /^oaath-op-v2:(session|owner):([0-9a-f]{64}|0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/;

export interface OAAthExecutionProviderInput {
  readonly oaath: Oaath | OaathOwnerClient;
  /** Existing smart-account identity; the SDK verifies the deployed account and root owner. */
  readonly account?: Readonly<{ kind: "existing"; address: Address; accountId?: string }>;
  readonly owner?: Parameters<OaathOwnerAccount["owner"]>[0] & OaathConnectedEoaFeePayer["wallet"];
  /** Auto chooses owner for one-operation chains or conclusive session-validation failure. */
  readonly signer?: "auto" | "owner" | "session";
  /** Auto permits SDK handleOps fallback after a conclusive bundler rejection. */
  readonly sender?: "auto" | "bundler";
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
  const signerInput = optionalField(input, "signer");
  const senderInput = optionalField(input, "sender");
  const signer = signerInput === undefined ? "auto" : signerInput;
  const sender = senderInput === undefined ? "auto" : senderInput;
  if (
    !["auto", "owner", "session"].includes(signer as string) ||
    !["auto", "bundler"].includes(sender as string)
  )
    return fail("oaath_input_invalid");
  const wallet = optionalField(input, "owner") as OAAthExecutionProviderInput["owner"];
  const accountInput = optionalField(input, "account");
  let account: { address: Address; accountId: string } | undefined;
  if (accountInput !== undefined) {
    const raw = capture(accountInput);
    const keys =
      optionalField(raw, "accountId") === undefined
        ? ["kind", "address"]
        : ["kind", "address", "accountId"];
    const descriptor = record(raw, keys);
    if (
      descriptor.kind !== "existing" ||
      !text(descriptor.address, /^0x[0-9a-fA-F]{40}$/) ||
      (descriptor.accountId !== undefined && !text(descriptor.accountId, ID))
    )
      return fail("oaath_input_invalid");
    account = {
      address: descriptor.address.toLowerCase() as Address,
      accountId: (descriptor.accountId as string) ?? descriptor.address.toLowerCase(),
    };
  }
  const connect =
    optionalField(client, "connect") === undefined ? undefined : connectionFactory(client as Oaath);
  const accountFactory =
    optionalField(client, "account") === undefined
      ? undefined
      : method<OaathOwnerClient["account"]>(client, "account");
  if (!connect && !accountFactory) return fail("oaath_input_invalid");
  if (wallet !== undefined && account === undefined) return fail("oaath_input_invalid");
  let ownerAccount: Readonly<OaathOwnerAccount> | undefined;
  let ownerHandle: Readonly<OaathOwnerHandle> | undefined;
  if (account !== undefined && accountFactory !== undefined) {
    ownerAccount = accountFactory(account.address);
    if (field(ownerAccount, "address") !== account.address) return fail("oaath_sdk_invalid");
    if (wallet !== undefined)
      ownerHandle = method<OaathOwnerAccount["owner"]>(ownerAccount, "owner")(wallet);
  }
  const extra =
    wallet !== undefined && sender === "auto"
      ? { feePayer: Object.freeze({ kind: "connected-eoa" as const, wallet }) }
      : {};
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
      sendCalls: (request: unknown) => grant.sendCalls({ ...(request as object), ...extra }),
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
        (signer === "auto" && ownerHandle !== undefined && units.length === 1 && !requiresOnchain);
      let rejectedSession: ExecutionProviderReview | undefined;
      if (!chooseOwner) {
        compileOAAthPlanPermission({ plan, packing });
        const canFallback = signer === "auto" && ownerHandle !== undefined && !requiresOnchain;
        const grant = await currentGrant(canFallback);
        const selected = await reviewGrant(plan, packing, grant, requirement.chainId, canFallback);
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
        if (fact.account !== account.address) return fail("oaath_sender_incompatible");
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
        const operationId = parsed[3];
        let operation: unknown;
        if (kind === "owner") {
          if (!account || !ownerAccount || context !== account.address)
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
        reference: `oaath-op-v2:${selected.kind}:${selected.context}:${id}`,
      });
    } catch (error) {
      if (error instanceof OAAthAdapterError) throw error;
      return fail("oaath_submission_failed");
    }
  }
  return Object.freeze(provider);
}
