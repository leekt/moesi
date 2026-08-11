import { MoesiExecutionError, MoesiRunError } from "./errors.js";
import type { MoesiExecutionProvider } from "./execution/provider.js";
import {
  type ExecutionProviderReview,
  MOESI_EXECUTION_REVIEW_VERSION,
  type ReviewedExecution,
} from "./execution/review.js";
import {
  parseExecutionProvider,
  parseReviewedExecution,
  validateProviderReviewForPlan,
} from "./execution/validate.js";
import { deepFreeze } from "./internal.js";
import { parseManifest } from "./manifest/parse.js";
import type { MoesiManifest } from "./manifest/types.js";
import type { MoesiObservationAdapter } from "./observation/types.js";
import { type DeploymentRunStore, parseDeploymentRunStore } from "./persistence/store.js";
import { createPlan } from "./planning/plan.js";
import { parseReviewedPlan } from "./planning/reviewed-plan.js";
import type { ReviewedPlan } from "./planning/types.js";
import { createDeploymentRun, resumeDeploymentRun } from "./run/runner.js";
import type { DeploymentRun, ObserveTiming } from "./run/types.js";
import { type MoesiVerificationResult, verifyPlanConvergence } from "./verification/convergence.js";

export interface CreateMoesiConfiguration {
  readonly observer: MoesiObservationAdapter;
  /** Required only for apply/resume. Read-only planning, review, and verification need no store. */
  readonly runStore?: DeploymentRunStore;
}

export interface MoesiPlanRequest {
  readonly manifest: MoesiManifest;
  readonly chains: readonly number[];
}

export interface MoesiReviewExecutionRequest {
  readonly plan: ReviewedPlan;
  readonly provider: MoesiExecutionProvider;
}

export interface MoesiApplyRequest {
  readonly plan: ReviewedPlan;
  readonly provider: MoesiExecutionProvider;
  readonly executionReview: ReviewedExecution;
  readonly observeTiming?: ObserveTiming;
}

export interface MoesiResumeRequest {
  readonly runId: string;
  readonly provider: MoesiExecutionProvider;
  readonly observeTiming?: ObserveTiming;
}

export interface MoesiVerifyRequest {
  readonly plan: ReviewedPlan;
}

export interface MoesiClient {
  plan(request: MoesiPlanRequest): Promise<ReviewedPlan>;
  verify(request: MoesiVerifyRequest): Promise<MoesiVerificationResult>;
  reviewExecution(request: MoesiReviewExecutionRequest): Promise<ReviewedExecution>;
  apply(request: MoesiApplyRequest): DeploymentRun;
  resume(request: MoesiResumeRequest): Promise<DeploymentRun>;
}

/**
 * The provider-neutral composition root. Planning, observation, drift, and
 * verification never touch an execution provider; execution goes through one
 * explicitly selected provider whose review Moesi validates and freezes.
 * Changing the provider requires a new `reviewExecution`.
 */
export function createMoesi(configuration: CreateMoesiConfiguration): MoesiClient {
  const observer = configuration.observer;
  const runStore = snapshotOptionalRunStore(configuration);
  const reviewedProviders = new WeakMap<ReviewedExecution, MoesiExecutionProvider>();

  return {
    async plan(request) {
      const manifest = parseManifest(request.manifest);
      return createPlan({
        manifest,
        chains: request.chains,
        observer,
      });
    },
    async verify(request) {
      const plan = parseReviewedPlan(request.plan);
      return verifyPlanConvergence({ observer, plan });
    },
    async reviewExecution(request) {
      const plan = parseReviewedPlan(request.plan);
      const provider = parseExecutionProvider(request.provider);
      let value: unknown;
      try {
        value = await provider.review({ plan });
      } catch {
        throw new MoesiExecutionError("provider_review_failed", "provider review failed");
      }
      let review: ExecutionProviderReview;
      try {
        review = validateProviderReviewForPlan(plan, value);
      } catch {
        throw new MoesiExecutionError("provider_review_invalid", "provider review is invalid");
      }
      if (review.providerId !== provider.id) {
        throw new MoesiExecutionError(
          "provider_mismatch",
          "the execution review does not belong to the selected provider",
        );
      }
      const accepted = deepFreeze({
        version: MOESI_EXECUTION_REVIEW_VERSION,
        planId: plan.planId,
        provider: review,
      }) as ReviewedExecution;
      reviewedProviders.set(accepted, provider);
      return accepted;
    },
    apply(request) {
      const planInput = request.plan;
      const providerInput = request.provider;
      const executionReviewInput = request.executionReview;
      const observeTiming = request.observeTiming;
      const plan = parseReviewedPlan(planInput);
      const provider = parseExecutionProvider(providerInput);
      if (reviewedProviders.get(executionReviewInput) !== provider) {
        throw new MoesiExecutionError(
          "provider_mismatch",
          "the execution review is not bound to this provider instance",
        );
      }
      let executionReview: ReviewedExecution;
      try {
        executionReview = parseReviewedExecution(executionReviewInput);
      } catch {
        throw new MoesiExecutionError("provider_review_invalid", "execution review is invalid");
      }
      if (executionReview.planId !== plan.planId) {
        throw new MoesiExecutionError(
          "plan_mismatch",
          "the execution review does not belong to the reviewed plan",
        );
      }
      const review = validateProviderReviewForPlan(plan, executionReview.provider);
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
      const requiredRunStore = requireRunStore(runStore);
      const run = createDeploymentRun({
        plan,
        provider,
        executionReview,
        observer,
        store: requiredRunStore,
        ...(observeTiming === undefined ? {} : { observeTiming }),
      });
      return run;
    },
    async resume(request) {
      const provider = parseExecutionProvider(request.provider);
      const requiredRunStore = requireRunStore(runStore);
      return resumeDeploymentRun({
        runId: request.runId,
        provider,
        observer,
        store: requiredRunStore,
        ...(request.observeTiming === undefined ? {} : { observeTiming: request.observeTiming }),
      });
    },
  };
}

function snapshotOptionalRunStore(
  configuration: CreateMoesiConfiguration,
): DeploymentRunStore | undefined {
  try {
    const input = configuration.runStore;
    return input === undefined ? undefined : parseDeploymentRunStore(input);
  } catch {
    throw new MoesiRunError(
      "run_store_required",
      "runStore must implement the DeploymentRunStore contract",
    );
  }
}

function requireRunStore(store: DeploymentRunStore | undefined): DeploymentRunStore {
  if (store === undefined) {
    throw new MoesiRunError("run_store_required", "apply and resume require a DeploymentRunStore");
  }
  return store;
}
