import type { Address } from "cetane";
import type { FinalizedProviderEvidence, ReviewedPlanOperation } from "../execution/reference.js";

/** Exact ordered calls and sender, checked independently of provider finality. */
export function finalizedCallsMatchOperation(
  operation: ReviewedPlanOperation,
  evidence: FinalizedProviderEvidence,
  expectedSender: Address | null,
): boolean {
  return (
    evidence.chainId === operation.chainId &&
    evidence.calls.length === operation.steps.length &&
    operation.steps.every(({ call }, index) => {
      const observed = evidence.calls[index];
      return (
        observed !== undefined &&
        observed.target === call.target &&
        observed.data === call.data &&
        observed.value === call.value
      );
    }) &&
    (expectedSender === null || evidence.sender === expectedSender)
  );
}
