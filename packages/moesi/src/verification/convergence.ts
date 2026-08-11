import { type Address, type Hex, keccak256 } from "viem";
import { deepFreeze } from "../internal.js";
import {
  captureChainSnapshot,
  observeCall,
  observeRuntimeCode,
  observeStorage,
} from "../observation/observe.js";
import type {
  ChainSnapshot,
  MoesiObservationAdapter,
  SnapshotReference,
} from "../observation/types.js";
import type { ResourceCell, ReviewedPlan } from "../planning/types.js";

export const MOESI_VERIFICATION_RESULT_VERSION = "moesi.verification-result/v1" as const;

export type ConfigurationVerificationResult = Readonly<{
  id: string;
  expectedResult: Hex;
  status:
    | { readonly kind: "satisfied"; readonly observedResult: Hex }
    | { readonly kind: "drifted"; readonly observedResult: Hex }
    | { readonly kind: "unreadable"; readonly reason: "read-failed" | "invalid-response" };
}>;

export type CallVerificationResult = Readonly<{
  id: string;
  expectedResult: Hex;
  status:
    | { readonly kind: "satisfied"; readonly observedResult: Hex }
    | { readonly kind: "drifted"; readonly observedResult: Hex }
    | { readonly kind: "unreadable"; readonly reason: "read-failed" | "invalid-response" };
}>;

export type StorageVerificationResult = Readonly<{
  id: string;
  slot: Hex;
  expectedWord: Hex;
  status:
    | { readonly kind: "satisfied"; readonly observedWord: Hex }
    | { readonly kind: "drifted"; readonly observedWord: Hex }
    | {
        readonly kind: "unreadable";
        readonly reason: "unavailable" | "read-failed" | "invalid-response";
      };
}>;

export type CellVerificationResult = Readonly<{
  resourceId: string;
  address: Address;
  expectedRuntimeCodeHash: Hex;
  storageChecks: readonly StorageVerificationResult[];
  callChecks: readonly CallVerificationResult[];
  configurations: readonly ConfigurationVerificationResult[];
  status:
    | { readonly kind: "satisfied"; readonly observedRuntimeCodeHash: Hex }
    | { readonly kind: "drifted"; readonly observedRuntimeCodeHash: Hex }
    | {
        readonly kind: "unreadable";
        readonly reason:
          | "snapshot-unreadable"
          | "snapshot-before-anchor"
          | "read-failed"
          | "invalid-response"
          | "configuration-read-failed"
          | "configuration-invalid-response"
          | "storage-unavailable"
          | "storage-read-failed"
          | "storage-invalid-response"
          | "call-read-failed"
          | "call-invalid-response"
          | "snapshot-not-descendant"
          | "ancestry-unreadable";
      };
}>;

export interface ChainConvergence {
  readonly status: "converged" | "drifted" | "unreadable";
  readonly snapshot: ChainSnapshot | null;
  readonly cells: readonly CellVerificationResult[];
}

export interface MoesiVerificationChainResult extends ChainConvergence {
  readonly chainId: number;
}

/**
 * A fresh, provider-independent observation of the desired state bound to one
 * exact ReviewedPlan. It makes no claim about which provider or transaction
 * produced that state.
 */
export interface MoesiVerificationResult {
  readonly version: "moesi.verification-result/v1";
  readonly planId: Hex;
  readonly manifestHash: Hex;
  readonly status: "converged" | "drifted" | "unreadable";
  readonly chains: readonly MoesiVerificationChainResult[];
}

export function unreadableCell(
  cell: ResourceCell,
  reason:
    | "snapshot-unreadable"
    | "snapshot-before-anchor"
    | "snapshot-not-descendant"
    | "ancestry-unreadable"
    | "read-failed"
    | "invalid-response",
): CellVerificationResult {
  return {
    resourceId: cell.resourceId,
    address: cell.address,
    expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
    storageChecks: [],
    callChecks: [],
    configurations: [],
    status: { kind: "unreadable", reason },
  };
}

/**
 * Re-observes one chain at a fresh pinned snapshot and verifies deployment
 * bytecode, exact read-only storage and call checks, and repairable
 * configuration for the plan's cells. This is Moesi's own semantic
 * verification; it is independent of provider evidence.
 *
 * The fresh snapshot must never be below the planning snapshot or any supplied
 * ancestry anchor. Only the anchors are additionally proven to be canonical
 * ancestors of the fresh snapshot: the run path anchors on the planning
 * snapshot plus its finalized execution evidence, while the standalone path
 * supplies none, because its reads are already pinned to the fresh canonical
 * snapshot and an ancestry walk would bound how old a plan can be verified.
 */
export async function verifyChainConvergence(input: {
  readonly observer: MoesiObservationAdapter;
  readonly plan: ReviewedPlan;
  readonly chainId: number;
  readonly ancestryAnchors: readonly SnapshotReference[];
}): Promise<ChainConvergence> {
  const cells = input.plan.cells.filter((cell) => cell.chainId === input.chainId);
  const planSnapshot = input.plan.snapshots.find(({ chainId }) => chainId === input.chainId);
  if (!planSnapshot || cells.length === 0) {
    return { status: "unreadable", snapshot: null, cells: [] };
  }
  let snapshot: ChainSnapshot;
  try {
    snapshot = await captureChainSnapshot(input.observer, input.chainId);
  } catch {
    return {
      status: "unreadable",
      snapshot: null,
      cells: cells.map((cell) => unreadableCell(cell, "snapshot-unreadable")),
    };
  }
  const ancestors = uniqueAncestors(input.ancestryAnchors);
  if (
    [planSnapshot, ...ancestors].some(
      (ancestor) => BigInt(snapshot.blockNumber) < BigInt(ancestor.blockNumber),
    )
  ) {
    return {
      status: "unreadable",
      snapshot,
      cells: cells.map((cell) => unreadableCell(cell, "snapshot-before-anchor")),
    };
  }
  for (const ancestor of ancestors) {
    let related: unknown;
    try {
      related = await input.observer.checkBlockAncestry({
        chainId: input.chainId,
        ancestor,
        descendant: snapshot,
      });
    } catch {
      return {
        status: "unreadable",
        snapshot,
        cells: cells.map((cell) => unreadableCell(cell, "ancestry-unreadable")),
      };
    }
    if (related !== true) {
      const reason = related === false ? "snapshot-not-descendant" : "ancestry-unreadable";
      return {
        status: "unreadable",
        snapshot,
        cells: cells.map((cell) => unreadableCell(cell, reason)),
      };
    }
  }

  const results: CellVerificationResult[] = [];
  for (const cell of cells) {
    const observed = await observeRuntimeCode(input.observer, {
      chainId: input.chainId,
      address: cell.address,
      snapshot,
    });
    if (observed.kind === "unreadable") {
      results.push(unreadableCell(cell, observed.reason));
      continue;
    }
    const observedRuntimeCodeHash = keccak256(observed.code);
    if (observedRuntimeCodeHash !== cell.expectedRuntimeCodeHash) {
      results.push({
        resourceId: cell.resourceId,
        address: cell.address,
        expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
        storageChecks: [],
        callChecks: [],
        configurations: [],
        status: { kind: "drifted", observedRuntimeCodeHash },
      });
      continue;
    }
    const storageChecks: StorageVerificationResult[] = [];
    for (const check of cell.storageChecks) {
      const result = await observeStorage(input.observer, {
        chainId: input.chainId,
        address: cell.address,
        slot: check.slot,
        snapshot,
      });
      storageChecks.push({
        id: check.id,
        slot: check.slot,
        expectedWord: check.expectedWord,
        status:
          result.kind === "unreadable"
            ? { kind: "unreadable", reason: result.reason }
            : result.word === check.expectedWord
              ? { kind: "satisfied", observedWord: result.word }
              : { kind: "drifted", observedWord: result.word },
      });
      if (result.kind === "unreadable") break;
    }
    const storageUnreadable = storageChecks.some(({ status }) => status.kind === "unreadable");
    const storageDrifted = storageChecks.some(({ status }) => status.kind === "drifted");
    if (storageUnreadable) {
      results.push({
        resourceId: cell.resourceId,
        address: cell.address,
        expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
        storageChecks,
        callChecks: [],
        configurations: [],
        status: {
          kind: "unreadable",
          reason: storageChecks.some(
            ({ status }) => status.kind === "unreadable" && status.reason === "unavailable",
          )
            ? "storage-unavailable"
            : storageChecks.some(
                  ({ status }) => status.kind === "unreadable" && status.reason === "read-failed",
                )
              ? "storage-read-failed"
              : "storage-invalid-response",
        },
      });
      continue;
    }
    const callChecks: CallVerificationResult[] = [];
    for (const check of cell.checks) {
      const result = await observeCall(input.observer, {
        chainId: input.chainId,
        target: cell.address,
        data: check.readData,
        caller: check.caller,
        snapshot,
      });
      callChecks.push({
        id: check.id,
        expectedResult: check.expectedResult,
        status:
          result.kind === "unreadable"
            ? { kind: "unreadable", reason: result.reason }
            : result.result === check.expectedResult
              ? { kind: "satisfied", observedResult: result.result }
              : { kind: "drifted", observedResult: result.result },
      });
      if (result.kind === "unreadable") break;
    }
    const callUnreadable = callChecks.some(({ status }) => status.kind === "unreadable");
    const callDrifted = callChecks.some(({ status }) => status.kind === "drifted");
    if (callUnreadable) {
      results.push({
        resourceId: cell.resourceId,
        address: cell.address,
        expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
        storageChecks,
        callChecks,
        configurations: [],
        status: {
          kind: "unreadable",
          reason: callChecks.some(
            ({ status }) => status.kind === "unreadable" && status.reason === "read-failed",
          )
            ? "call-read-failed"
            : "call-invalid-response",
        },
      });
      continue;
    }
    const configurations: ConfigurationVerificationResult[] = [];
    for (const configuration of cell.configuration) {
      const result = await observeCall(input.observer, {
        chainId: input.chainId,
        target: cell.address,
        data: configuration.readData,
        caller: configuration.caller,
        snapshot,
      });
      configurations.push({
        id: configuration.id,
        expectedResult: configuration.expectedResult,
        status:
          result.kind === "unreadable"
            ? { kind: "unreadable", reason: result.reason }
            : result.result === configuration.expectedResult
              ? { kind: "satisfied", observedResult: result.result }
              : { kind: "drifted", observedResult: result.result },
      });
      if (result.kind === "unreadable") break;
    }
    const configurationUnreadable = configurations.some(
      ({ status }) => status.kind === "unreadable",
    );
    const configurationDrifted = configurations.some(({ status }) => status.kind === "drifted");
    results.push({
      resourceId: cell.resourceId,
      address: cell.address,
      expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
      storageChecks,
      callChecks,
      configurations,
      status: configurationUnreadable
        ? {
            kind: "unreadable",
            reason: configurations.some(
              ({ status }) => status.kind === "unreadable" && status.reason === "read-failed",
            )
              ? "configuration-read-failed"
              : "configuration-invalid-response",
          }
        : storageDrifted || callDrifted || configurationDrifted
          ? { kind: "drifted", observedRuntimeCodeHash }
          : { kind: "satisfied", observedRuntimeCodeHash },
    });
  }
  const status = results.some(({ status: cellStatus }) => cellStatus.kind === "unreadable")
    ? "unreadable"
    : results.some(({ status: cellStatus }) => cellStatus.kind === "drifted")
      ? "drifted"
      : "converged";
  return { status, snapshot, cells: results };
}

/**
 * Verifies every chain in canonical plan order using one fresh pinned snapshot
 * per chain. This read-only path deliberately accepts no provider or
 * caller-supplied execution evidence and walks no ancestry: every read is
 * pinned to the fresh canonical snapshot, so a plan stays verifiable no matter
 * how far the chain has advanced since it was reviewed. The fresh snapshot
 * must still be at or past the planning snapshot.
 */
export async function verifyPlanConvergence(input: {
  readonly observer: MoesiObservationAdapter;
  readonly plan: ReviewedPlan;
}): Promise<MoesiVerificationResult> {
  const chains: MoesiVerificationChainResult[] = [];
  for (const { chainId } of input.plan.snapshots) {
    const convergence = await verifyChainConvergence({
      observer: input.observer,
      plan: input.plan,
      chainId,
      ancestryAnchors: [],
    });
    chains.push({ chainId, ...convergence });
  }
  const status = chains.some((chain) => chain.status === "unreadable")
    ? "unreadable"
    : chains.some((chain) => chain.status === "drifted")
      ? "drifted"
      : "converged";
  return deepFreeze({
    version: MOESI_VERIFICATION_RESULT_VERSION,
    planId: input.plan.planId,
    manifestHash: input.plan.manifestHash,
    status,
    chains,
  });
}

function uniqueAncestors(values: readonly SnapshotReference[]): SnapshotReference[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.blockNumber}:${value.blockHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
