import type { Address } from "viem";
import { MoesiExecutionError } from "../errors.js";
import type { PreparedProviderExecution } from "../execution/prepared.js";
import type { MoesiExecutionProvider } from "../execution/provider.js";
import type {
  FinalizedProviderEvidence,
  ProviderExecutionEvidence,
  ProviderExecutionReference,
} from "../execution/reference.js";
import type { ExecutionProviderReview } from "../execution/review.js";
import {
  parseExecutionProvider,
  parseExecutionProviderReview,
  parsePreparedProviderExecution,
  parseProviderExecutionEvidence,
  parseProviderExecutionReference,
} from "../execution/validate.js";
import { deepFreeze, hashCanonical } from "../internal.js";
import { captureChainSnapshot } from "../observation/observe.js";
import type { MoesiObservationAdapter } from "../observation/types.js";
import { parseReviewedPlan } from "../planning/reviewed-plan.js";
import type { DeploymentStep, ReviewedPlan } from "../planning/types.js";
import { finalizedCallsMatchStep } from "../verification/calls.js";
import {
  type CellVerificationResult,
  unreadableCell,
  verifyChainConvergence,
} from "../verification/convergence.js";
import type {
  DeploymentRun,
  DeploymentRunResult,
  ObserveTiming,
  RunChainResult,
  RunExecutionFailure,
  RunExecutionResult,
  RunStepEvidence,
} from "./types.js";
import { MOESI_RUN_RESULT_VERSION } from "./types.js";

const DEFAULT_OBSERVE_ATTEMPTS = 16;
const DEFAULT_OBSERVE_DELAY_MS = 1_000;
const MAX_OBSERVE_ATTEMPTS = 64;
const MAX_OBSERVE_DELAY_MS = 60_000;

export interface CreateDeploymentRunInput {
  readonly plan: ReviewedPlan;
  readonly provider: MoesiExecutionProvider;
  readonly review: ExecutionProviderReview;
  readonly observer: MoesiObservationAdapter;
  readonly observeTiming?: ObserveTiming;
}

/**
 * One in-memory DeploymentRun: orchestrates the reviewed steps through the
 * selected provider, then re-observes and verifies convergence. `wait`
 * executes at most once. A failure never retries or resubmits a step.
 */
export function createDeploymentRun(input: CreateDeploymentRunInput): DeploymentRun {
  const plan = parseReviewedPlan(input.plan);
  const provider = parseExecutionProvider(input.provider);
  const review = parseExecutionProviderReview(input.review);
  if (review.providerId !== provider.id) {
    throw new MoesiExecutionError(
      "provider_mismatch",
      "the execution review does not belong to the selected provider",
    );
  }
  if (review.status !== "supported") {
    throw new MoesiExecutionError(
      "provider_review_blocked",
      "the execution review is blocked; resolve every reason and review again",
    );
  }
  const timing = parseObserveTiming(input.observeTiming);
  const runId = globalThis.crypto.randomUUID();
  let state: DeploymentRun["state"] = "ready";
  let waiting: Promise<DeploymentRunResult> | undefined;

  const run = {
    runId,
    planId: plan.planId,
    get state() {
      return state;
    },
    wait() {
      if (!waiting) {
        state = "running";
        waiting = Promise.resolve()
          .then(() => executeAndVerify(runId, plan, provider, review, input.observer, timing))
          .then(
            (result) => {
              state = "complete";
              return result;
            },
            (error: unknown) => {
              state = "complete";
              throw error;
            },
          );
      }
      return waiting;
    },
  } satisfies DeploymentRun;

  return Object.freeze(run);
}

interface ResolvedObserveTiming {
  readonly attempts: number;
  readonly delayMs: number;
}

function parseObserveTiming(input: ObserveTiming | undefined): ResolvedObserveTiming {
  const attempts = input?.attempts ?? DEFAULT_OBSERVE_ATTEMPTS;
  const delayMs = input?.delayMs ?? DEFAULT_OBSERVE_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_OBSERVE_ATTEMPTS) {
    throw new MoesiExecutionError(
      "provider_invalid",
      `observe attempts must be an integer between 1 and ${MAX_OBSERVE_ATTEMPTS}`,
    );
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_OBSERVE_DELAY_MS) {
    throw new MoesiExecutionError(
      "provider_invalid",
      `observe delay must be an integer between 0 and ${MAX_OBSERVE_DELAY_MS}`,
    );
  }
  return { attempts, delayMs };
}

async function executeAndVerify(
  runId: string,
  plan: ReviewedPlan,
  provider: MoesiExecutionProvider,
  review: ExecutionProviderReview,
  observer: MoesiObservationAdapter,
  timing: ResolvedObserveTiming,
): Promise<DeploymentRunResult> {
  let currentReviewValue: unknown;
  try {
    currentReviewValue = await provider.review({ plan });
  } catch {
    throw new MoesiExecutionError("provider_review_failed", "provider re-review failed");
  }
  let currentReview: ExecutionProviderReview;
  try {
    currentReview = parseExecutionProviderReview(currentReviewValue);
  } catch {
    throw new MoesiExecutionError("provider_review_invalid", "provider re-review is invalid");
  }
  if (
    currentReview.providerId !== provider.id ||
    hashCanonical(currentReview) !== hashCanonical(review)
  ) {
    throw new MoesiExecutionError(
      "provider_mismatch",
      "the provider decision changed since execution review",
    );
  }

  await verifyPlanningSnapshotLineage(plan, observer);

  let prepared: PreparedProviderExecution | null = null;
  if (plan.steps.length > 0) {
    try {
      const value = await provider.prepare({ plan, review });
      prepared = parsePreparedProviderExecution(value, provider.id, plan.planId);
    } catch {
      throw new MoesiExecutionError("provider_prepare_failed", "provider prepare failed");
    }
  }
  const chainIds = [...new Set(plan.cells.map(({ chainId }) => chainId))].sort(
    (left, right) => left - right,
  );
  const chains = await Promise.all(
    chainIds.map((chainId) => {
      const expectedSender = review.chains.find(
        (candidate) => candidate.chainId === chainId,
      )?.sender;
      return executeAndVerifyChain(
        plan,
        chainId,
        provider,
        prepared,
        expectedSender ?? null,
        observer,
        timing,
      );
    }),
  );
  const convergedCount = chains.filter(({ status }) => status === "converged").length;
  const status =
    convergedCount === chains.length ? "converged" : convergedCount > 0 ? "partial" : "failed";
  return deepFreeze({
    version: MOESI_RUN_RESULT_VERSION,
    runId,
    planId: plan.planId,
    manifestHash: plan.manifestHash,
    status,
    chains,
  });
}

async function verifyPlanningSnapshotLineage(
  plan: ReviewedPlan,
  observer: MoesiObservationAdapter,
): Promise<void> {
  try {
    await Promise.all(
      plan.snapshots.map(async (ancestor) => {
        const descendant = await captureChainSnapshot(observer, ancestor.chainId);
        if (BigInt(descendant.blockNumber) < BigInt(ancestor.blockNumber)) {
          throw new Error("snapshot height moved backward");
        }
        const related = await observer.checkBlockAncestry({
          chainId: ancestor.chainId,
          ancestor,
          descendant,
        });
        if (related !== true) throw new Error("snapshot is not canonical");
      }),
    );
  } catch {
    throw new MoesiExecutionError(
      "plan_snapshot_unverifiable",
      "the reviewed planning snapshot is no longer verifiably canonical",
    );
  }
}

async function executeAndVerifyChain(
  plan: ReviewedPlan,
  chainId: number,
  provider: MoesiExecutionProvider,
  prepared: PreparedProviderExecution | null,
  expectedSender: Address | null,
  observer: MoesiObservationAdapter,
  timing: ResolvedObserveTiming,
): Promise<RunChainResult> {
  const steps = plan.steps.filter((step) => step.chainId === chainId);
  const planSnapshot = plan.snapshots.find((snapshot) => snapshot.chainId === chainId);
  if (!planSnapshot) throw new MoesiExecutionError("plan_mismatch", "plan snapshot is missing");
  const executed: RunStepEvidence[] = [];
  const references = new Set<string>();
  const evidenceIds = new Set<string>();
  let latestExecutionBlock = BigInt(planSnapshot.blockNumber);
  let failure: RunExecutionFailure | null = null;
  if (steps.length > 0) {
    if (prepared === null) {
      throw new MoesiExecutionError("provider_prepare_failed", "steps exist without preparation");
    }
    for (const step of steps) {
      const outcome = await executeStep(
        plan,
        chainId,
        step,
        provider,
        prepared,
        expectedSender,
        timing,
      );
      if (outcome.kind === "finalized") {
        executed.push(outcome.submitted);
        const referenceKey = outcome.submitted.reference.reference;
        const evidenceId = outcome.submitted.providerEvidence.providerEvidenceId;
        const blockNumber = BigInt(outcome.submitted.providerEvidence.blockNumber);
        if (
          references.has(referenceKey) ||
          evidenceIds.has(evidenceId) ||
          blockNumber <= latestExecutionBlock
        ) {
          failure = "invalid-evidence";
          break;
        }
        references.add(referenceKey);
        evidenceIds.add(evidenceId);
        latestExecutionBlock = blockNumber;
        continue;
      }
      if (outcome.submitted !== null) executed.push(outcome.submitted);
      failure = outcome.reason;
      break;
    }
  }

  if (failure !== null) {
    return deepFreeze({
      chainId,
      status: "execution-failed",
      execution: { kind: "failed", providerId: provider.id, reason: failure, steps: executed },
      snapshot: null,
      cells: plan.cells
        .filter((cell) => cell.chainId === chainId)
        .map((cell) => unreadableCell(cell, "execution-unverified")),
    });
  }

  const execution: RunExecutionResult =
    steps.length === 0
      ? { kind: "not-required" }
      : { kind: "finalized", providerId: provider.id, steps: executed };
  const convergence = await verifyChainConvergence({
    observer,
    plan,
    chainId,
    executionAncestors: executed.flatMap(({ providerEvidence }) =>
      providerEvidence === null
        ? []
        : [
            {
              blockNumber: providerEvidence.blockNumber,
              blockHash: providerEvidence.blockHash,
            },
          ],
    ),
  });
  return deepFreeze({
    chainId,
    status: convergence.status,
    execution,
    snapshot: convergence.snapshot,
    cells: convergence.cells as readonly CellVerificationResult[],
  });
}

type StepOutcome =
  | { readonly kind: "finalized"; readonly submitted: FinalizedRunStepEvidence }
  | {
      readonly kind: "failed";
      readonly reason: RunExecutionFailure;
      readonly submitted: RunStepEvidence | null;
    };

type FinalizedRunStepEvidence = Omit<RunStepEvidence, "providerEvidence"> & {
  readonly providerEvidence: FinalizedProviderEvidence;
};

async function executeStep(
  plan: ReviewedPlan,
  chainId: number,
  step: DeploymentStep,
  provider: MoesiExecutionProvider,
  prepared: PreparedProviderExecution,
  expectedSender: Address | null,
  timing: ResolvedObserveTiming,
): Promise<StepOutcome> {
  let reference: ProviderExecutionReference;
  try {
    const submitted = await provider.submit({
      prepared,
      action: { planId: plan.planId, chainId, step },
    });
    reference = parseProviderExecutionReference(submitted, provider.id, chainId);
  } catch (error) {
    if (error instanceof MoesiExecutionError && error.code === "provider_mismatch") {
      return { kind: "failed", reason: "invalid-evidence", submitted: null };
    }
    return { kind: "failed", reason: "execution-failed", submitted: null };
  }

  for (let attempt = 0; attempt < timing.attempts; attempt += 1) {
    if (attempt > 0 && timing.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, timing.delayMs));
    }
    let evidence: ProviderExecutionEvidence;
    try {
      const observed = await provider.observe({ reference });
      try {
        evidence = parseProviderExecutionEvidence(observed);
      } catch {
        evidence = { status: "unreadable", reason: "invalid-evidence" };
      }
    } catch {
      evidence = { status: "unreadable", reason: "observation-unavailable" };
    }
    if (evidence.status === "finalized") {
      const submitted = {
        stepId: step.id,
        reference,
        providerEvidence: evidence.finalized,
      } satisfies RunStepEvidence;
      const planSnapshot = plan.snapshots.find((snapshot) => snapshot.chainId === chainId);
      if (
        !planSnapshot ||
        BigInt(evidence.finalized.blockNumber) <= BigInt(planSnapshot.blockNumber)
      ) {
        return { kind: "failed", reason: "invalid-evidence", submitted };
      }
      if (!finalizedCallsMatchStep(step, evidence.finalized, expectedSender)) {
        return { kind: "failed", reason: "call-mismatch", submitted };
      }
      return {
        kind: "finalized",
        submitted,
      };
    }
    if (evidence.status === "failed") {
      return {
        kind: "failed",
        reason: "execution-failed",
        submitted: { stepId: step.id, reference, providerEvidence: null },
      };
    }
    if (evidence.status === "unreadable" && evidence.reason === "invalid-evidence") {
      return {
        kind: "failed",
        reason: "invalid-evidence",
        submitted: { stepId: step.id, reference, providerEvidence: null },
      };
    }
    // pending or observation-unavailable: keep observing; never resubmit.
  }
  return {
    kind: "failed",
    reason: "execution-unresolved",
    submitted: { stepId: step.id, reference, providerEvidence: null },
  };
}
