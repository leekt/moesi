import type { Address, Hex } from "viem";
import type { ExecutionPacking } from "./operations.js";

export const MOESI_EXECUTION_REVIEW_VERSION = "moesi.execution-review/v2" as const;

/**
 * The enforcement level a provider actually delivers, exposed before any
 * signing. `interactive-owner` means the reviewed calls are enforced only by
 * the human review at apply time; `onchain` means an enforcing system (such as
 * an OAAth permission) constrains execution onchain.
 */
export interface ProviderEnforcementReview {
  readonly calls: "onchain" | "interactive-owner" | "not-enforced";
  readonly expiry: "onchain" | "runtime" | "not-enforced";
  readonly operationCount: "onchain" | "runtime" | "not-enforced";
}

/** Machine reason for a blocked (or noteworthy) provider review decision. */
export interface ExecutionProviderReason {
  readonly code: string;
  readonly chainId: number | null;
  readonly stepId: string | null;
}

/**
 * One chain-local provider decision. `sender` is the exact execution address;
 * `accountId` binds a logical smart-account requirement to the identity the
 * provider resolved. Route and enforcement may differ by chain.
 */
export interface ExecutionProviderChainReview {
  readonly chainId: number;
  readonly sender: Address | null;
  readonly accountId: string | null;
  readonly route: string;
  readonly signer: "owner" | "session" | "unavailable";
  /** Structured reason for the selected signer, never provider diagnostic prose. */
  readonly signerReason: string;
  readonly enforcement: ProviderEnforcementReview;
}

/**
 * The provider-owned review of one plan. A `blocked` review must carry at least
 * one machine reason and is refused by `apply` before any signing.
 */
export interface ExecutionProviderReview {
  readonly providerId: string;
  readonly status: "supported" | "blocked";
  readonly chains: readonly ExecutionProviderChainReview[];
  readonly reasons: readonly ExecutionProviderReason[];
}

declare const reviewedExecutionBrand: unique symbol;

/**
 * An execution review accepted by Moesi. The wrapper binds the provider-owned
 * review to the exact immutable plan so it cannot be replayed for different
 * calls, sender requirements, or enforcement requirements.
 */
export interface ReviewedExecution {
  readonly [reviewedExecutionBrand]: true;
  readonly version: typeof MOESI_EXECUTION_REVIEW_VERSION;
  readonly planId: Hex;
  readonly packing: ExecutionPacking;
  readonly provider: ExecutionProviderReview;
}
