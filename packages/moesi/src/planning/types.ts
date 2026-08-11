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

export type DeploymentCapabilityStatus =
  | { readonly kind: "available"; readonly observedRuntimeCodeHash: Hex }
  | { readonly kind: "missing" }
  | { readonly kind: "bytecode-drift"; readonly observedRuntimeCodeHash: Hex }
  | { readonly kind: "unreadable"; readonly reason: "read-failed" | "invalid-response" };

interface DeploymentCapabilityBase {
  readonly chainId: number;
  readonly address: Address;
  readonly expectedRuntimeCodeHash: Hex;
  readonly status: DeploymentCapabilityStatus;
}

/** Pinned evidence that one chain has the canonical Arachnid CREATE2 proxy. */
export interface Create2FactoryDeploymentCapability extends DeploymentCapabilityBase {
  readonly kind: "create2-factory-v1";
}

/** Pinned evidence that one chain has the canonical CreateX factory. */
export interface CreateXCreate2DeploymentCapability extends DeploymentCapabilityBase {
  readonly kind: "createx-factory-v1";
}

/** Closed deployment capability set, keyed by chain and strategy kind. */
export type DeploymentCapability =
  | Create2FactoryDeploymentCapability
  | CreateXCreate2DeploymentCapability;

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

export interface ReviewedCallCheck {
  readonly id: string;
  readonly readData: Hex;
  readonly caller: Address;
  readonly expectedResult: Hex;
}

export interface ReviewedStorageCheck {
  readonly id: string;
  readonly slot: Hex;
  readonly expectedWord: Hex;
}

export interface ConfigurationResult {
  readonly id: string;
  readonly result: Hex;
}

export interface CallResult {
  readonly id: string;
  readonly result: Hex;
}

export interface ConfigurationMismatch {
  readonly id: string;
  readonly expectedResult: Hex;
  readonly observedResult: Hex;
}

export interface CallMismatch {
  readonly id: string;
  readonly expectedResult: Hex;
  readonly observedResult: Hex;
}

export interface StorageResult {
  readonly id: string;
  readonly word: Hex;
}

export interface StorageMismatch {
  readonly id: string;
  readonly expectedWord: Hex;
  readonly observedWord: Hex;
}

export interface ResourceCellBase {
  readonly resourceId: string;
  readonly chainId: number;
  readonly address: Address;
  readonly expectedRuntimeCodeHash: Hex;
  readonly configuration: readonly ReviewedConfiguration[];
  readonly checks: readonly ReviewedCallCheck[];
  readonly storageChecks: readonly ReviewedStorageCheck[];
}

export interface ConvergedResourceCell extends ResourceCellBase {
  readonly status: {
    readonly kind: "converged";
    readonly observedRuntimeCodeHash: Hex;
    readonly configurationResults: readonly ConfigurationResult[];
    readonly callResults: readonly CallResult[];
    readonly storageResults: readonly StorageResult[];
  };
}

export interface DriftResourceCell extends ResourceCellBase {
  readonly status: {
    readonly kind: "drift";
    readonly observedRuntimeCodeHash: Hex;
    readonly configurationMismatches: readonly ConfigurationMismatch[];
    readonly callMismatches: readonly CallMismatch[];
    readonly storageMismatches: readonly StorageMismatch[];
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

export type UnreadableReason = "unavailable" | "read-failed" | "invalid-response";

export type UnreadableResourceStatus =
  | {
      readonly kind: "unreadable";
      readonly source: "runtime-code";
      readonly id: null;
      readonly reason: "read-failed" | "invalid-response";
    }
  | {
      readonly kind: "unreadable";
      readonly source: "storage-check";
      readonly id: string;
      readonly reason: "unavailable" | "read-failed" | "invalid-response";
      readonly observedRuntimeCodeHash: Hex;
    }
  | {
      readonly kind: "unreadable";
      readonly source: "call-check" | "configuration";
      readonly id: string;
      readonly reason: "read-failed" | "invalid-response";
      readonly observedRuntimeCodeHash: Hex;
    };

export interface UnreadableResourceCell extends ResourceCellBase {
  readonly status: UnreadableResourceStatus;
}

export type ResourceCell =
  | ConvergedResourceCell
  | MissingResourceCell
  | DriftResourceCell
  | BytecodeDriftResourceCell
  | UnreadableResourceCell;

export interface PlanDraft {
  readonly manifest: MoesiManifest;
  readonly snapshots: readonly ChainSnapshot[];
  readonly capabilities: readonly DeploymentCapability[];
  readonly cells: readonly ResourceCell[];
  readonly steps: readonly DeploymentStep[];
}

declare const reviewedPlanBrand: unique symbol;

export interface ReviewedPlan {
  readonly [reviewedPlanBrand]: true;
  readonly version: "moesi.reviewed-plan/v2";
  readonly planId: Hex;
  readonly manifest: MoesiManifest;
  readonly manifestHash: Hex;
  readonly disposition: PlanDisposition;
  readonly snapshots: readonly ChainSnapshot[];
  readonly capabilities: readonly DeploymentCapability[];
  readonly cells: readonly ResourceCell[];
  readonly steps: readonly DeploymentStep[];
  readonly requirements: readonly ExecutionRequirements[];
}
