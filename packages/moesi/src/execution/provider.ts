import type { ReviewedPlan } from "../planning/types.js";
import type { ExecutionPacking } from "./operations.js";
import type { PreparedProviderExecution } from "./prepared.js";
import type {
  ProviderExecutionEvidence,
  ProviderExecutionReference,
  ReviewedPlanAction,
  ReviewedPlanOperation,
} from "./reference.js";
import type { ExecutionProviderReview } from "./review.js";

/**
 * The small outcome-oriented contract every execution provider implements.
 *
 * - `review` signs and submits nothing; it exposes the sender, route, and the
 *   enforcement level the provider actually delivers for this plan.
 * - `prepare` binds the selected account/sender/authorization and the exact
 *   reviewed calls; it signs and submits nothing.
 * - `submit` executes exactly one reviewed action and returns a stable
 *   provider-owned reference.
 * - Optional `submitBatch` executes the exact ordered steps atomically and
 *   returns one reference. Review and prepare bind the packing choice.
 * - `observe` is read-only and performs zero submissions; the reference alone
 *   must be sufficient to resume observation after process loss.
 *
 * A provider that cannot satisfy required enforcement returns `blocked` from
 * `review` before any signing. Moesi never silently substitutes one provider
 * for another.
 */
export interface MoesiExecutionProvider {
  readonly id: string;
  /**
   * Packing used when a caller does not choose one. Absent means `per-chain`
   * for providers with `submitBatch` and `per-step` otherwise.
   */
  readonly defaultPacking?: ExecutionPacking;

  review(input: {
    readonly plan: ReviewedPlan;
    readonly packing: ExecutionPacking;
  }): Promise<ExecutionProviderReview>;

  prepare(input: {
    readonly plan: ReviewedPlan;
    readonly review: ExecutionProviderReview;
    readonly packing: ExecutionPacking;
  }): Promise<PreparedProviderExecution>;

  submit(input: {
    readonly prepared: PreparedProviderExecution;
    readonly action: ReviewedPlanAction;
  }): Promise<ProviderExecutionReference>;

  /** Presence promises atomic execution of every supplied step in one operation. */
  submitBatch?(input: {
    readonly prepared: PreparedProviderExecution;
    readonly operation: ReviewedPlanOperation;
  }): Promise<ProviderExecutionReference>;

  observe(input: {
    readonly reference: ProviderExecutionReference;
  }): Promise<ProviderExecutionEvidence>;
}
