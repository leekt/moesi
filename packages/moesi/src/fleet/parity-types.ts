import type { Address, Hex } from "viem";
import type { ConfigurationPeer, MoesiManifest } from "../manifest/types.js";
import type { ObservationCause } from "../observation/failure.js";
import type { ConfigurationPeerObservation, ConfigurationReadiness } from "../observation/peers.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "../observation/types.js";
import type { PlanDisposition } from "../planning/types.js";

export const MOESI_FLEET_BASELINE_VERSION = "moesi.fleet-baseline/v1" as const;
export const MOESI_FLEET_PARITY_VERSION = "moesi.fleet-parity/v1" as const;
export interface FleetBaselineConfiguration {
  readonly id: string;
  readonly caller: Address;
  readonly readData: Hex;
  readonly expectedResult: Hex;
  readonly after: readonly ConfigurationPeer[];
}
export interface FleetBaselineCall {
  readonly id: string;
  readonly target: Address;
  readonly caller: Address;
  readonly readData: Hex;
  readonly expectedResult: Hex;
}
export interface FleetBaselineStorage {
  readonly id: string;
  readonly slot: Hex;
  readonly expectedWord: Hex;
}
export interface FleetBaselineCell {
  readonly chainId: number;
  readonly resourceId: string;
  readonly kind: "managed" | "external";
  readonly address: Address;
  readonly expectedRuntimeCodeHash: Hex;
  readonly configuration: readonly FleetBaselineConfiguration[];
  readonly checks: readonly FleetBaselineCall[];
  readonly storageChecks: readonly FleetBaselineStorage[];
}
/** Resolved declarations from the existing application, not a cached claim about live state. */
export interface FleetBaseline {
  readonly version: typeof MOESI_FLEET_BASELINE_VERSION;
  readonly cells: readonly FleetBaselineCell[];
}
export type FleetParityErrorCode =
  | "unsupported_fleet_baseline_version"
  | "invalid_fleet_baseline"
  | "invalid_parity_request"
  | "baseline_chain_missing";
export class MoesiFleetParityError extends Error {
  readonly code: FleetParityErrorCode;
  constructor(code: FleetParityErrorCode) {
    super(code);
    this.name = "MoesiFleetParityError";
    this.code = code;
  }
}
export type FleetParityDifferenceCode =
  | "resource_missing"
  | "resource_added"
  | "resource_kind_mismatch"
  | "address_mismatch"
  | "runtime_hash_mismatch"
  | "read_missing"
  | "read_added"
  | "expected_result_mismatch"
  | "peer_requirements_mismatch"
  | "runtime_observation_mismatch"
  | "read_observation_mismatch";
export interface FleetParityDifference {
  readonly code: FleetParityDifferenceCode;
  readonly readKind?: "configuration" | "call" | "storage";
  readonly baselineId?: string;
  readonly candidateId?: string;
}
export type FleetParityReadObservation =
  | { readonly kind: "readable"; readonly value: Hex }
  | { readonly kind: "not-deployed" }
  | {
      readonly kind: "unreadable";
      readonly reason:
        | "runtime-unreadable"
        | "snapshot-unreadable"
        | "read-failed"
        | "invalid-response"
        | "unavailable";
      readonly cause?: ObservationCause;
    };
export type FleetParityRuntime =
  | { readonly kind: "missing" }
  | { readonly kind: "deployed"; readonly runtimeCodeHash: Hex }
  | {
      readonly kind: "unreadable";
      readonly reason: "snapshot-unreadable" | "read-failed" | "invalid-response";
      readonly cause?: ObservationCause;
    };
export interface FleetParityObservedCell extends FleetBaselineCell {
  readonly runtime: FleetParityRuntime;
  readonly liveState: "converged" | "drifted" | "missing" | "pending" | "unreadable";
  readonly configuration: readonly (FleetBaselineConfiguration & {
    readonly readiness: ConfigurationReadiness;
    readonly observation: FleetParityReadObservation;
  })[];
  readonly checks: readonly (FleetBaselineCall & {
    readonly observation: FleetParityReadObservation;
  })[];
  readonly storageChecks: readonly (FleetBaselineStorage & {
    readonly observation: FleetParityReadObservation;
  })[];
}
export interface FleetParityCell {
  readonly resourceId: string;
  readonly baseline: FleetParityObservedCell | null;
  readonly candidate: FleetParityObservedCell | null;
  readonly differences: readonly FleetParityDifference[];
}
export interface FleetParityChain {
  readonly chainId: number;
  readonly snapshot: ChainSnapshot | null;
  readonly candidatePlan: { readonly planId: Hex; readonly disposition: PlanDisposition } | null;
  readonly error?: {
    readonly code: "snapshot_unreadable" | "invalid_snapshot";
    readonly cause?: ObservationCause;
  };
  readonly peers: readonly ConfigurationPeerObservation[];
  readonly cells: readonly FleetParityCell[];
}
export interface FleetParityResult {
  readonly version: typeof MOESI_FLEET_PARITY_VERSION;
  readonly baselineHash: Hex;
  readonly manifestHash: Hex;
  /** Match means identical declarations and readable live results, not convergence. */
  readonly status: "match" | "different" | "unreadable";
  readonly chains: readonly FleetParityChain[];
}
export interface CheckFleetParityInput {
  readonly baseline: FleetBaseline;
  readonly manifest: MoesiManifest;
  readonly chains: readonly number[];
  readonly observer: MoesiObservationAdapter;
  readonly signal?: AbortSignal;
}
