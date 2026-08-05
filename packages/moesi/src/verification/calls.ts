import type { Address } from "viem";
import type { FinalizedProviderEvidence } from "../execution/reference.js";
import type { DeploymentStep } from "../planning/types.js";

/**
 * Moesi-side execution verification: the finalized provider evidence must
 * carry exactly the reviewed call of the action it claims to have executed,
 * on the reviewed chain, from the reviewed sender when the step binds an exact
 * address. Provider finality claims are never proof of these facts by
 * themselves.
 */
export function finalizedCallsMatchStep(
  step: DeploymentStep,
  evidence: FinalizedProviderEvidence,
  expectedSender: Address | null,
): boolean {
  if (evidence.chainId !== step.chainId) return false;
  if (evidence.calls.length !== 1) return false;
  const call = evidence.calls[0];
  if (!call) return false;
  if (
    call.target !== step.call.target ||
    call.data !== step.call.data ||
    call.value !== step.call.value
  ) {
    return false;
  }
  if (expectedSender !== null && evidence.sender !== expectedSender) return false;
  return true;
}
