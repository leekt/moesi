import type { Hex } from "cetane";
import type {
  FinalizedProviderEvidence,
  ProviderExecutionReference,
} from "../execution/reference.js";
import type { ChainSnapshot } from "../observation/types.js";
import type { CellVerificationResult } from "../verification/convergence.js";

export const MOESI_RUN_RESULT_VERSION = "moesi.run-result/v9" as const;

/** Automatic recovery observes saved operations without starting pending work. */
export type ResumeMode = "continue" | "observe-only";

/**
 * One submitted operation's durable provider reference. `providerEvidence` is null
 * while submission is unresolved and retained when the provider returned
 * finalized evidence, even if Moesi rejected that evidence as a call mismatch.
 */
export interface RunOperationEvidence {
  readonly operationId: string;
  readonly stepIds: readonly string[];
  readonly reference: ProviderExecutionReference;
  readonly providerEvidence: FinalizedProviderEvidence | null;
}

export type RunExecutionFailure =
  | "execution-failed"
  | "invalid-evidence"
  | "call-mismatch"
  | "execution-unresolved"
  | "submission-ambiguous"
  | "stop-requested"
  | "pending-execution"
  | "deployment-capability-mismatch"
  | "deployment-capability-unverified"
  | "deployment-prerequisite-mismatch"
  | "deployment-prerequisite-unverified"
  | "configuration-runtime-mismatch"
  | "configuration-peer-unverified"
  | "configuration-runtime-unverified";

/** `failed` still carries every submitted reference, including the unresolved
 * reference that caused the failure. Partial progress never authorizes blind
 * resubmission. */
export type RunExecutionResult =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "finalized";
      readonly providerId: string;
      readonly operations: readonly RunOperationEvidence[];
    }
  | {
      readonly kind: "failed";
      readonly providerId: string;
      readonly reason: RunExecutionFailure;
      readonly operations: readonly RunOperationEvidence[];
    };

export interface RunChainResult {
  readonly chainId: number;
  readonly status: "converged" | "drifted" | "unreadable" | "execution-failed";
  readonly execution: RunExecutionResult;
  readonly snapshot: ChainSnapshot | null;
  readonly cells: readonly RunCellVerificationResult[];
}

export type RunCellVerificationResult =
  | CellVerificationResult
  | Readonly<
      Omit<CellVerificationResult, "configurations" | "status"> & {
        readonly configurations: readonly [];
        readonly status: {
          readonly kind: "unreadable";
          readonly reason: "execution-unverified";
        };
      }
    >;

export interface DeploymentRunResult {
  readonly version: "moesi.run-result/v9";
  readonly runId: string;
  readonly planId: Hex;
  readonly manifestHash: Hex;
  readonly status: "converged" | "partial" | "failed";
  readonly chains: readonly RunChainResult[];
}

export interface DeploymentRun {
  readonly runId: string;
  readonly planId: Hex;
  readonly state: "ready" | "running" | "recovery-required" | "complete";
  /** Requests a cooperative stop at the next durable side-effect boundary. */
  requestStop(): void;
  wait(): Promise<DeploymentRunResult>;
}

/** Bounded observation polling after submission. Observation never submits. */
export interface ObserveTiming {
  readonly attempts?: number;
  readonly delayMs?: number;
}
