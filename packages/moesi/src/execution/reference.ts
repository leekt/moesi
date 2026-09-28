import type { Address, Hex } from "viem";
import type { DeploymentCall, DeploymentStep } from "../planning/types.js";

/**
 * One exact reviewed action handed to a provider for submission. One action is
 * one step: the provider submits exactly `step.call` and returns a reference
 * that binds that single submission.
 */
export interface ReviewedPlanAction {
  readonly planId: Hex;
  readonly chainId: number;
  readonly step: DeploymentStep;
}

/** All steps execute atomically in one provider operation, in this exact order. */
export interface ReviewedPlanOperation {
  readonly id: string;
  readonly planId: Hex;
  readonly chainId: number;
  readonly steps: readonly DeploymentStep[];
}

/**
 * Durable, JSON-safe provider-owned execution reference. It is sufficient to
 * resume observation after process loss: the viem provider uses a versioned
 * transaction identity containing the hash and finality policy, while another
 * provider may use an operation ID. Moesi stores the reference but never
 * interprets it.
 */
export interface ProviderExecutionReference {
  readonly providerId: string;
  readonly chainId: number;
  readonly reference: string;
}

/**
 * Provider-neutral finalized execution facts. Moesi verifies these against the
 * reviewed operation (exact ordered calls, required sender) independently of the provider's
 * own claim. `providerEvidenceId` is the provider-visible inclusion identity
 * (transaction hash for the direct viem provider). The inclusion block number
 * and hash are retained so convergence can prove one coherent chain lineage.
 */
export interface FinalizedProviderEvidence {
  readonly chainId: number;
  readonly sender: Address;
  readonly calls: readonly DeploymentCall[];
  readonly providerEvidenceId: Hex;
  readonly blockNumber: string;
  readonly blockHash: Hex;
}

/**
 * One read-only observation pass over a provider reference. `pending` and
 * `unreadable` are never proof of absence: they never authorize resubmission.
 */
export type ProviderExecutionEvidence =
  | { readonly status: "finalized"; readonly finalized: FinalizedProviderEvidence }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "pending" }
  | {
      readonly status: "unreadable";
      readonly reason: "observation-unavailable" | "invalid-evidence";
    };
