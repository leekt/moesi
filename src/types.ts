import type { Address, Hex } from "viem";

export type DriftKind = "missing" | "configuration-drift";
export type PlanDisposition = "converged" | "changes" | "blocked" | "partial";

export interface ChainSnapshot {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
}

export interface DeploymentCall {
  readonly target: Address;
  readonly data: Hex;
  readonly value: bigint;
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
  readonly expectedResult: Hex;
}

export type DeploymentPostcondition = RuntimeCodeHashPostcondition | StaticCallPostcondition;

export interface DeploymentStep {
  readonly id: string;
  readonly resourceId: string;
  readonly chainId: number;
  readonly kind: "deploy" | "configure";
  readonly configurationId: string | null;
  readonly drift: DriftKind;
  readonly call: DeploymentCall;
  readonly postconditions: readonly DeploymentPostcondition[];
}

export interface ReviewedConfiguration {
  readonly id: string;
  readonly readData: Hex;
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
  readonly manifestHash: Hex;
  readonly snapshots: readonly ChainSnapshot[];
  readonly cells: readonly ResourceCell[];
  readonly steps: readonly DeploymentStep[];
}

export interface ReviewedCallScope {
  readonly target: Address;
  readonly selector: Hex;
  readonly calldata: Hex;
  readonly value: bigint;
}

export interface ReviewedPolicy {
  readonly chainScope: "all";
  readonly calls: readonly ReviewedCallScope[];
  readonly perChainOperationLimit: number;
}

declare const reviewedPlanBrand: unique symbol;

export interface ReviewedPlan {
  readonly [reviewedPlanBrand]: true;
  readonly version: "moesi.reviewed-plan/v1";
  readonly planId: Hex;
  readonly manifestHash: Hex;
  readonly disposition: PlanDisposition;
  readonly snapshots: readonly ChainSnapshot[];
  readonly cells: readonly ResourceCell[];
  readonly steps: readonly DeploymentStep[];
  readonly policy: ReviewedPolicy;
}
