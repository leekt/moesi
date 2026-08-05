import type { Address, Hex } from "viem";
import type { MoesiManifest } from "../manifest/types.js";
import type { ChainSnapshot } from "../observation/types.js";

export type DriftKind = "missing" | "configuration-drift";
export type PlanDisposition = "converged" | "changes" | "blocked" | "partial";

export interface DeploymentCall {
  readonly target: Address;
  readonly data: Hex;
  /** Canonical decimal uint256 string so reviewed calls remain JSON-safe. */
  readonly value: string;
}

export interface RuntimeCodeHashPostcondition {
  readonly kind: "runtime-code-hash";
  readonly address: Address;
  readonly expectedHash: Hex;
}

export interface StaticCallPostcondition {
  readonly kind: "static-call";
  readonly target: Address;
  readonly data: Hex;
  readonly caller: Address;
  readonly expectedResult: Hex;
}

export type DeploymentPostcondition = RuntimeCodeHashPostcondition | StaticCallPostcondition;

/** Sender requirement compiled onto one step from the manifest declaration. */
export type StepSender =
  | { readonly kind: "reviewed-owner-eoa"; readonly address: Address }
  | { readonly kind: "logical-smart-account"; readonly accountId: string };

/** Provider-neutral enforcement requirement shared by manifest, step, and plan. */
export interface PlanEnforcement {
  readonly callScope: "required-onchain" | "interactive-review-sufficient";
  readonly expiry: "required" | "optional";
  readonly operationLimit: "required" | "optional";
}

export const DEFAULT_PLAN_ENFORCEMENT: PlanEnforcement = Object.freeze({
  callScope: "interactive-review-sufficient",
  expiry: "optional",
  operationLimit: "optional",
});

export const MAX_PLAN_CHAINS = 32;

export interface DeploymentStep {
  readonly id: string;
  readonly resourceId: string;
  readonly chainId: number;
  readonly kind: "deploy" | "configure";
  readonly configurationId: string | null;
  readonly drift: DriftKind;
  readonly call: DeploymentCall;
  readonly postconditions: readonly DeploymentPostcondition[];
  /** Null means the step is sender-independent. */
  readonly sender: StepSender | null;
  readonly enforcement: PlanEnforcement;
}

/**
 * Provider-neutral sender requirement for one chain. `sender-independent`
 * means any sender preserves address, ownership, and postcondition semantics
 * (ordinary CREATE2 factory deployments, permissionless writes).
 */
export type PlanSender =
  | { readonly kind: "exact"; readonly address: Address }
  | { readonly kind: "logical-smart-account"; readonly accountId: string }
  | { readonly kind: "reviewed-owner-eoa"; readonly address: Address }
  | { readonly kind: "sender-independent" };

/**
 * The canonical provider-neutral execution requirement for one chain. It owns
 * the exact reviewed calls and the policy an enforcing provider (such as the
 * OAAth adapter) compiles into its own authorization request. Provider-specific
 * accounts, grants, signers, nonces, routes, and operations never appear here.
 */
export interface ExecutionRequirements {
  readonly chainId: number;
  readonly calls: readonly DeploymentCall[];
  readonly sender: PlanSender;
  readonly enforcement: PlanEnforcement;
  readonly postconditions: readonly DeploymentPostcondition[];
}

export interface ReviewedConfiguration {
  readonly id: string;
  readonly readData: Hex;
  readonly caller: Address;
  readonly expectedResult: Hex;
}

export interface ConfigurationResult {
  readonly id: string;
  readonly result: Hex;
}

export interface ConfigurationMismatch {
  readonly id: string;
  readonly expectedResult: Hex;
  readonly observedResult: Hex;
}

export interface ResourceCellBase {
  readonly resourceId: string;
  readonly chainId: number;
  readonly address: Address;
  readonly expectedRuntimeCodeHash: Hex;
  readonly configuration: readonly ReviewedConfiguration[];
}

export interface ConvergedResourceCell extends ResourceCellBase {
  readonly status: {
    readonly kind: "converged";
    readonly observedRuntimeCodeHash: Hex;
    readonly configurationResults: readonly ConfigurationResult[];
  };
}

export interface ConfigurationDriftResourceCell extends ResourceCellBase {
  readonly status: {
    readonly kind: "configuration-drift";
    readonly observedRuntimeCodeHash: Hex;
    readonly mismatches: readonly ConfigurationMismatch[];
  };
}

export interface MissingResourceCell extends ResourceCellBase {
  readonly status: {
    readonly kind: "missing";
  };
}

export interface BytecodeDriftResourceCell extends ResourceCellBase {
  readonly status: {
    readonly kind: "bytecode-drift";
    readonly observedRuntimeCodeHash: Hex;
  };
}

export type UnreadableReason =
  | "read-failed"
  | "invalid-response"
  | "configuration-read-failed"
  | "configuration-invalid-response";

export interface UnreadableResourceCell extends ResourceCellBase {
  readonly status: {
    readonly kind: "unreadable";
    readonly reason: UnreadableReason;
    readonly configurationId: string | null;
  };
}

export type ResourceCell =
  | ConvergedResourceCell
  | MissingResourceCell
  | ConfigurationDriftResourceCell
  | BytecodeDriftResourceCell
  | UnreadableResourceCell;

export interface PlanDraft {
  readonly manifest: MoesiManifest;
  readonly snapshots: readonly ChainSnapshot[];
  readonly cells: readonly ResourceCell[];
  readonly steps: readonly DeploymentStep[];
}

declare const reviewedPlanBrand: unique symbol;

export interface ReviewedPlan {
  readonly [reviewedPlanBrand]: true;
  readonly version: "moesi.reviewed-plan/v1";
  readonly planId: Hex;
  readonly manifest: MoesiManifest;
  readonly manifestHash: Hex;
  readonly disposition: PlanDisposition;
  readonly snapshots: readonly ChainSnapshot[];
  readonly cells: readonly ResourceCell[];
  readonly steps: readonly DeploymentStep[];
  readonly requirements: readonly ExecutionRequirements[];
}
