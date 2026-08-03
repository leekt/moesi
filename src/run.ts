import { type Address, type Hex, keccak256 } from "viem";
import { deepFreeze } from "./internal.js";
import {
  captureChainSnapshot,
  type MoesiObservationAdapter,
  observeCall,
  observeRuntimeCode,
} from "./planner.js";
import { parseReviewedPlan } from "./reviewed-plan.js";
import type { ChainSnapshot, DeploymentCall, ResourceCell, ReviewedPlan } from "./types.js";

export const MOESI_RUN_RESULT_VERSION = "moesi.run-result/v1" as const;

export interface FinalizedExecutionReference {
  readonly chainId: number;
  readonly operationId: Hex;
}

export interface ExecuteReviewedChainInput {
  readonly planId: Hex;
  readonly manifestHash: Hex;
  readonly chainId: number;
  readonly calls: readonly DeploymentCall[];
}

/** Resolve only after OGP (or an equivalent authority owner) has verified that
 * this exact chain-local reviewed batch finalized successfully. Throw or return
 * malformed evidence for every unresolved, reverted, dropped, or unreadable
 * operation. DeploymentRun never retries this capability. */
export type ExecuteReviewedChain = (
  input: ExecuteReviewedChainInput,
) => Promise<FinalizedExecutionReference | unknown>;

export type RunExecutionResult =
  | { readonly kind: "not-required" }
  | { readonly kind: "finalized"; readonly operationId: Hex }
  | { readonly kind: "failed"; readonly reason: "execution-failed" | "invalid-evidence" };

export type CellVerificationResult = Readonly<{
  resourceId: string;
  address: Address;
  expectedRuntimeCodeHash: Hex;
  configurations: readonly ConfigurationVerificationResult[];
  status:
    | { readonly kind: "satisfied"; readonly observedRuntimeCodeHash: Hex }
    | { readonly kind: "drifted"; readonly observedRuntimeCodeHash: Hex }
    | {
        readonly kind: "unreadable";
        readonly reason:
          | "execution-unverified"
          | "snapshot-unreadable"
          | "read-failed"
          | "invalid-response"
          | "configuration-read-failed"
          | "configuration-invalid-response";
      };
}>;

export type ConfigurationVerificationResult = Readonly<{
  id: string;
  expectedResult: Hex;
  status:
    | { readonly kind: "satisfied"; readonly observedResult: Hex }
    | { readonly kind: "drifted"; readonly observedResult: Hex }
    | { readonly kind: "unreadable"; readonly reason: "read-failed" | "invalid-response" };
}>;

export interface RunChainResult {
  readonly chainId: number;
  readonly status: "converged" | "drifted" | "unreadable" | "execution-failed";
  readonly execution: RunExecutionResult;
  readonly snapshot: ChainSnapshot | null;
  readonly cells: readonly CellVerificationResult[];
}

export interface DeploymentRunResult {
  readonly version: "moesi.run-result/v1";
  readonly runId: string;
  readonly planId: Hex;
  readonly manifestHash: Hex;
  readonly status: "converged" | "partial" | "failed";
  readonly chains: readonly RunChainResult[];
}

export interface DeploymentRun {
  readonly runId: string;
  readonly planId: Hex;
  readonly state: "ready" | "running" | "complete";
  wait(): Promise<DeploymentRunResult>;
}

export interface CreateDeploymentRunInput {
  readonly plan: ReviewedPlan;
  readonly observer: MoesiObservationAdapter;
  readonly execute: ExecuteReviewedChain;
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function createDeploymentRun(input: CreateDeploymentRunInput): DeploymentRun {
  const plan = parseReviewedPlan(input.plan);
  const runId = globalThis.crypto.randomUUID();
  let state: DeploymentRun["state"] = "ready";
  let waiting: Promise<DeploymentRunResult> | undefined;

  const run = {
    runId,
    planId: plan.planId,
    get state() {
      return state;
    },
    wait() {
      if (!waiting) {
        state = "running";
        waiting = executeAndVerify(runId, plan, input.observer, input.execute).then((result) => {
          state = "complete";
          return result;
        });
      }
      return waiting;
    },
  } satisfies DeploymentRun;

  return Object.freeze(run);
}

async function executeAndVerify(
  runId: string,
  plan: ReviewedPlan,
  observer: MoesiObservationAdapter,
  execute: ExecuteReviewedChain,
): Promise<DeploymentRunResult> {
  const chainIds = [...new Set(plan.cells.map(({ chainId }) => chainId))].sort(
    (left, right) => left - right,
  );
  const chains = await Promise.all(
    chainIds.map((chainId) => executeAndVerifyChain(plan, chainId, observer, execute)),
  );
  const convergedCount = chains.filter(({ status }) => status === "converged").length;
  const status =
    convergedCount === chains.length ? "converged" : convergedCount > 0 ? "partial" : "failed";
  return deepFreeze({
    version: MOESI_RUN_RESULT_VERSION,
    runId,
    planId: plan.planId,
    manifestHash: plan.manifestHash,
    status,
    chains,
  });
}

async function executeAndVerifyChain(
  plan: ReviewedPlan,
  chainId: number,
  observer: MoesiObservationAdapter,
  execute: ExecuteReviewedChain,
): Promise<RunChainResult> {
  const steps = plan.steps.filter((step) => step.chainId === chainId);
  let execution: RunExecutionResult = { kind: "not-required" };
  if (steps.length > 0) {
    const request = deepFreeze({
      planId: plan.planId,
      manifestHash: plan.manifestHash,
      chainId,
      calls: steps.map(({ call }) => call),
    });
    let evidence: unknown;
    try {
      evidence = await execute(request);
    } catch {
      return executionFailed(plan, chainId, "execution-failed");
    }
    const operationId = parseOperationId(evidence, chainId);
    if (!operationId) return executionFailed(plan, chainId, "invalid-evidence");
    execution = { kind: "finalized", operationId };
  }

  let snapshot: ChainSnapshot;
  try {
    snapshot = await captureChainSnapshot(observer, chainId);
  } catch {
    return deepFreeze({
      chainId,
      status: "unreadable",
      execution,
      snapshot: null,
      cells: plan.cells
        .filter((cell) => cell.chainId === chainId)
        .map((cell) => unreadableCell(cell, "snapshot-unreadable")),
    });
  }

  const cells: CellVerificationResult[] = [];
  for (const cell of plan.cells.filter((candidate) => candidate.chainId === chainId)) {
    const observed = await observeRuntimeCode(observer, {
      chainId,
      address: cell.address,
      snapshot,
    });
    if (observed.kind === "unreadable") {
      cells.push(unreadableCell(cell, observed.reason));
      continue;
    }
    const observedRuntimeCodeHash = keccak256(observed.code);
    if (observedRuntimeCodeHash !== cell.expectedRuntimeCodeHash) {
      cells.push({
        resourceId: cell.resourceId,
        address: cell.address,
        expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
        configurations: [],
        status: { kind: "drifted", observedRuntimeCodeHash },
      });
      continue;
    }
    const configurations: ConfigurationVerificationResult[] = [];
    for (const configuration of cell.configuration) {
      const result = await observeCall(observer, {
        chainId,
        target: cell.address,
        data: configuration.readData,
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
    }
    const configurationUnreadable = configurations.some(
      ({ status }) => status.kind === "unreadable",
    );
    const configurationDrifted = configurations.some(({ status }) => status.kind === "drifted");
    cells.push({
      resourceId: cell.resourceId,
      address: cell.address,
      expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
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
        : configurationDrifted
          ? { kind: "drifted", observedRuntimeCodeHash }
          : { kind: "satisfied", observedRuntimeCodeHash },
    });
  }
  const status = cells.some(({ status: cellStatus }) => cellStatus.kind === "unreadable")
    ? "unreadable"
    : cells.some(({ status: cellStatus }) => cellStatus.kind === "drifted")
      ? "drifted"
      : "converged";
  return deepFreeze({ chainId, status, execution, snapshot, cells });
}

function parseOperationId(value: unknown, expectedChainId: number): Hex | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "chainId" && key !== "operationId")) return null;
    if (record.chainId !== expectedChainId) return null;
    if (typeof record.operationId !== "string" || !HASH_PATTERN.test(record.operationId))
      return null;
    return record.operationId.toLowerCase() as Hex;
  } catch {
    return null;
  }
}

function executionFailed(
  plan: ReviewedPlan,
  chainId: number,
  reason: "execution-failed" | "invalid-evidence",
): RunChainResult {
  return deepFreeze({
    chainId,
    status: "execution-failed",
    execution: { kind: "failed", reason },
    snapshot: null,
    cells: plan.cells
      .filter((cell) => cell.chainId === chainId)
      .map((cell) => unreadableCell(cell, "execution-unverified")),
  });
}

function unreadableCell(
  cell: ResourceCell,
  reason: "execution-unverified" | "snapshot-unreadable" | "read-failed" | "invalid-response",
): CellVerificationResult {
  return {
    resourceId: cell.resourceId,
    address: cell.address,
    expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
    configurations: [],
    status: { kind: "unreadable", reason },
  };
}
