import { MoesiExecutionError } from "../errors.js";
import { deepFreeze } from "../internal.js";
import { parseReviewedPlan } from "../planning/reviewed-plan.js";
import type { ReviewedPlan } from "../planning/types.js";
import type { ReviewedPlanOperation } from "./reference.js";

export type ExecutionPacking = "per-step" | "per-chain";

export function parseExecutionPacking(value: unknown): ExecutionPacking {
  if (value !== "per-step" && value !== "per-chain")
    throw new MoesiExecutionError("invalid_execution_packing", "execution packing is invalid");
  return value;
}

/** Exact ordered units of submission. Packing never changes or omits a reviewed call. */
export function compileExecutionOperations(
  input: ReviewedPlan,
  inputPacking: ExecutionPacking,
): readonly ReviewedPlanOperation[] {
  const plan = parseReviewedPlan(input);
  const packing = parseExecutionPacking(inputPacking);
  const groups =
    packing === "per-step"
      ? plan.steps.map((step) => [step])
      : plan.requirements.map(({ chainId }) =>
          plan.steps.filter((step) => step.chainId === chainId),
        );
  return deepFreeze(
    groups.map((steps) => ({
      id: packing === "per-step" ? steps[0]!.id : `chain-${steps[0]!.chainId}`,
      planId: plan.planId,
      chainId: steps[0]!.chainId,
      steps,
    })),
  );
}
