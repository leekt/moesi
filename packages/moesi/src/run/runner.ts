import { type Address, keccak256 } from "viem";
import { MoesiExecutionError, MoesiRunError } from "../errors.js";
import { compileExecutionOperations, type ExecutionPacking } from "../execution/operations.js";
import type { PreparedProviderExecution } from "../execution/prepared.js";
import type { MoesiExecutionProvider } from "../execution/provider.js";
import type {
  FinalizedProviderEvidence,
  ProviderExecutionEvidence,
  ProviderExecutionReference,
  ReviewedPlanOperation,
} from "../execution/reference.js";
import type { ExecutionProviderReview, ReviewedExecution } from "../execution/review.js";
import {
  parseExecutionProvider,
  parseExecutionProviderReview,
  parsePreparedProviderExecution,
  parseProviderExecutionEvidence,
  parseProviderExecutionReference,
  parseReviewedExecution,
  validateProviderReviewForPlan,
} from "../execution/validate.js";
import { deepFreeze, hashCanonical } from "../internal.js";
import { peerKey } from "../manifest/peers.js";
import { captureChainSnapshot, observeCall, observeRuntimeCode } from "../observation/observe.js";
import { observeConfigurationPeers, peerSnapshotDescends } from "../observation/peers.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "../observation/types.js";
import type { DeploymentRunStore } from "../persistence/store.js";
import { deploymentCapabilitySpec } from "../planning/resource.js";
import { parseReviewedPlan } from "../planning/reviewed-plan.js";
import type { DeploymentStep, ResourceCell, ReviewedPlan } from "../planning/types.js";
import { finalizedCallsMatchOperation } from "../verification/calls.js";
import { verifyChainConvergence } from "../verification/convergence.js";
import {
  createDeploymentRunRecord,
  type DeploymentRunOperationRecord,
  type DeploymentRunRecord,
  deploymentRunNeedsRecovery,
  parseDeploymentRunId,
  parseDeploymentRunRecord,
  transitionDeploymentRunOperation,
} from "./record.js";
import type {
  DeploymentRun,
  DeploymentRunResult,
  ObserveTiming,
  ResumeMode,
  RunCellVerificationResult,
  RunChainResult,
  RunExecutionFailure,
  RunExecutionResult,
  RunOperationEvidence,
} from "./types.js";
import { MOESI_RUN_RESULT_VERSION } from "./types.js";

const DEFAULT_OBSERVE_ATTEMPTS = 16;
const DEFAULT_OBSERVE_DELAY_MS = 1_000;
const MAX_OBSERVE_ATTEMPTS = 64;
const MAX_OBSERVE_DELAY_MS = 60_000;

export interface CreateDeploymentRunInput {
  readonly plan: ReviewedPlan;
  readonly provider: MoesiExecutionProvider;
  readonly executionReview: ReviewedExecution;
  readonly observer: MoesiObservationAdapter;
  readonly store: DeploymentRunStore;
  readonly observeTiming?: ObserveTiming;
}

export interface ResumeDeploymentRunInput {
  readonly mode?: ResumeMode | undefined;
  readonly runId: string;
  readonly provider: MoesiExecutionProvider;
  readonly observer: MoesiObservationAdapter;
  readonly store: DeploymentRunStore;
  readonly observeTiming?: ObserveTiming;
}

interface ProviderObserver {
  readonly id: string;
  observe(input: {
    readonly reference: ProviderExecutionReference;
  }): Promise<ProviderExecutionEvidence>;
}

type PendingOperationExecutor = (
  operation: ReviewedPlanOperation,
  expectedSender: Address | null,
  sequence: EvidenceSequence,
) => Promise<OperationOutcome>;

/**
 * Creates a durably checkpointed run. Every possible provider submission is
 * preceded by a persisted `submission-requested` fence, and the returned
 * provider reference is checkpointed before observation begins.
 */
export function createDeploymentRun(input: CreateDeploymentRunInput): DeploymentRun {
  const plan = parseReviewedPlan(input.plan);
  const provider = parseExecutionProvider(input.provider);
  const executionReview = parseReviewedExecution(input.executionReview);
  const review = validateRunReview(plan, provider.id, executionReview);
  const timing = parseObserveTiming(input.observeTiming);
  const runId = plan.planId;
  const checkpoint = new RunCheckpoint(
    input.store,
    createDeploymentRunRecord({ plan, executionReview }),
  );
  let state: DeploymentRun["state"] = "ready";
  let waiting: Promise<DeploymentRunResult> | undefined;
  let stopRequested = false;

  const run = {
    runId,
    planId: plan.planId,
    get state() {
      return state;
    },
    requestStop() {
      stopRequested = true;
    },
    wait() {
      if (!waiting) {
        state = "running";
        waiting = Promise.resolve()
          .then(() =>
            executeAndVerify(
              plan,
              provider,
              review,
              input.observer,
              timing,
              checkpoint,
              () => stopRequested,
            ),
          )
          .then(
            (result) => {
              state = runStateAfterWait(checkpoint);
              return result;
            },
            (error: unknown) => {
              state = runStateAfterWait(checkpoint);
              throw error;
            },
          );
      }
      return waiting;
    },
  } satisfies DeploymentRun;

  return Object.freeze(run);
}

/**
 * Reconstructs a run from untrusted durable state. The recovery worker receives
 * only the provider's id and `observe` method while handling retained
 * references. A persisted possible-submission fence without a reference stays
 * ambiguous. Only a provably untouched `pending` operation can re-run exact preflight
 * and pass through the normal durable fence before submission. Observe-only mode
 * withholds that executor entirely and leaves pending operations unchanged.
 */
export async function resumeDeploymentRun(input: ResumeDeploymentRunInput): Promise<DeploymentRun> {
  const mode = input.mode === undefined ? "continue" : input.mode;
  if (mode !== "continue" && mode !== "observe-only") {
    throw new MoesiRunError("invalid_resume_mode", "resume mode must be continue or observe-only");
  }
  const provider = parseExecutionProvider(input.provider);
  const record = await loadRun(input.store, input.runId);
  if (record.providerId !== provider.id) {
    throw new MoesiRunError(
      "run_provider_mismatch",
      "deployment run belongs to a different execution provider",
    );
  }
  const timing = parseObserveTiming(input.observeTiming);
  const checkpoint = new RunCheckpoint(input.store, record, true);
  const providerObserver: ProviderObserver = Object.freeze({
    id: provider.id,
    observe: (request: { readonly reference: ProviderExecutionReference }) =>
      provider.observe(request),
  });
  let prepared: Promise<PreparedProviderExecution> | undefined;
  const executePendingOperation: PendingOperationExecutor = async (
    operation,
    expectedSender,
    sequence,
  ) => {
    if (!prepared) {
      const retainedExecutionAncestors = checkpoint.record.operations.flatMap((stored) =>
        stored.phase === "finalized"
          ? [
              {
                chainId: stored.chainId,
                blockNumber: stored.providerEvidence.blockNumber,
                blockHash: stored.providerEvidence.blockHash,
              },
            ]
          : [],
      );
      prepared = preflightExecution(
        record.plan,
        provider,
        record.executionReview.provider,
        record.executionReview.packing,
        input.observer,
        retainedExecutionAncestors,
      ).then((result) => {
        if (result === null) {
          throw new MoesiExecutionError(
            "provider_prepare_failed",
            "steps exist without preparation",
          );
        }
        return result;
      });
    }
    return executeOperation(
      record.plan,
      operation,
      provider,
      await prepared,
      expectedSender,
      input.observer,
      timing,
      checkpoint,
      sequence,
      () => stopRequested,
    );
  };
  let state: DeploymentRun["state"] = "ready";
  let waiting: Promise<DeploymentRunResult> | undefined;
  let stopRequested = false;

  const run = {
    runId: record.runId,
    planId: record.plan.planId,
    get state() {
      return state;
    },
    requestStop() {
      stopRequested = true;
    },
    wait() {
      if (!waiting) {
        state = "running";
        waiting = Promise.resolve()
          .then(() =>
            resumeAndVerify(
              providerObserver,
              mode === "observe-only" ? null : executePendingOperation,
              input.observer,
              timing,
              checkpoint,
              () => stopRequested,
            ),
          )
          .then(
            (result) => {
              state = runStateAfterWait(checkpoint);
              return result;
            },
            (error: unknown) => {
              state = runStateAfterWait(checkpoint);
              throw error;
            },
          );
      }
      return waiting;
    },
  } satisfies DeploymentRun;

  return Object.freeze(run);
}

class RunCheckpoint {
  #record: DeploymentRunRecord;
  #persistenceAttempted: boolean;

  constructor(
    private readonly store: DeploymentRunStore,
    record: DeploymentRunRecord,
    persisted = false,
  ) {
    this.#record = record;
    this.#persistenceAttempted = persisted;
  }

  get record(): DeploymentRunRecord {
    return this.#record;
  }

  get persistenceAttempted(): boolean {
    return this.#persistenceAttempted;
  }

  async create(): Promise<void> {
    this.#persistenceAttempted = true;
    try {
      await this.store.create(this.#record);
    } catch (error) {
      throwStoreError(error);
    }
  }

  async transition(
    operationId: string,
    nextOperation: DeploymentRunOperationRecord,
  ): Promise<void> {
    const next = transitionDeploymentRunOperation(this.#record, operationId, nextOperation);
    this.#persistenceAttempted = true;
    try {
      await this.store.save(next, { expectedRevision: this.#record.revision });
    } catch (error) {
      throwStoreError(error);
    }
    this.#record = next;
  }
}

function runStateAfterWait(checkpoint: RunCheckpoint): DeploymentRun["state"] {
  return checkpoint.persistenceAttempted && deploymentRunNeedsRecovery(checkpoint.record)
    ? "recovery-required"
    : "complete";
}

function throwStoreError(error: unknown): never {
  const code = snapshotStoreErrorCode(error);
  if (code === "run_store_conflict") {
    throw new MoesiRunError("run_store_conflict", "deployment run store conflict");
  }
  if (code === "run_not_found") {
    throw new MoesiRunError("run_not_found", "deployment run does not exist");
  }
  if (
    code === "unsupported_run_version" ||
    code === "run_record_invalid" ||
    code === "run_plan_mismatch" ||
    code === "run_provider_mismatch"
  ) {
    throw new MoesiRunError(code, "deployment run store contains invalid state");
  }
  throw new MoesiRunError("run_store_failed", "deployment run store operation failed");
}

function snapshotStoreErrorCode(error: unknown): MoesiRunError["code"] | null {
  try {
    if (!(error instanceof MoesiRunError)) return null;
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? (code as MoesiRunError["code"]) : null;
  } catch {
    return null;
  }
}

async function loadRun(store: DeploymentRunStore, runId: string): Promise<DeploymentRunRecord> {
  const parsedRunId = parseDeploymentRunId(runId);
  let value: unknown;
  try {
    value = await store.get(parsedRunId);
  } catch (error) {
    return throwStoreError(error);
  }
  if (value === undefined) {
    throw new MoesiRunError("run_not_found", "deployment run does not exist");
  }
  const record = parseDeploymentRunRecord(value);
  if (record.runId !== parsedRunId) {
    throw new MoesiRunError("run_record_invalid", "deployment run store returned another run");
  }
  return record;
}

function validateRunReview(
  plan: ReviewedPlan,
  providerId: string,
  executionReview: ReviewedExecution,
): ExecutionProviderReview {
  if (executionReview.planId !== plan.planId) {
    throw new MoesiExecutionError(
      "plan_mismatch",
      "the execution review does not belong to the reviewed plan",
    );
  }
  const review = validateProviderReviewForPlan(plan, executionReview.provider);
  if (review.providerId !== providerId) {
    throw new MoesiExecutionError(
      "provider_mismatch",
      "the execution review does not belong to the selected provider",
    );
  }
  if (review.status !== "supported") {
    throw new MoesiExecutionError(
      "provider_review_blocked",
      "the execution review is blocked; resolve every reason and review again",
    );
  }
  return review;
}

interface ResolvedObserveTiming {
  readonly attempts: number;
  readonly delayMs: number;
}

function parseObserveTiming(input: ObserveTiming | undefined): ResolvedObserveTiming {
  const attempts = input?.attempts ?? DEFAULT_OBSERVE_ATTEMPTS;
  const delayMs = input?.delayMs ?? DEFAULT_OBSERVE_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_OBSERVE_ATTEMPTS) {
    throw new MoesiExecutionError(
      "provider_invalid",
      `observe attempts must be an integer between 1 and ${MAX_OBSERVE_ATTEMPTS}`,
    );
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_OBSERVE_DELAY_MS) {
    throw new MoesiExecutionError(
      "provider_invalid",
      `observe delay must be an integer between 0 and ${MAX_OBSERVE_DELAY_MS}`,
    );
  }
  return { attempts, delayMs };
}

async function executeAndVerify(
  plan: ReviewedPlan,
  provider: MoesiExecutionProvider,
  review: ExecutionProviderReview,
  observer: MoesiObservationAdapter,
  timing: ResolvedObserveTiming,
  checkpoint: RunCheckpoint,
  shouldStop: () => boolean,
): Promise<DeploymentRunResult> {
  const prepared = await preflightExecution(
    plan,
    provider,
    review,
    checkpoint.record.executionReview.packing,
    observer,
  );
  // Review, lineage validation, and preparation are side-effect free. Occupy
  // the plan's one durable run identity only after those preflight checks pass.
  await checkpoint.create();
  const chains: RunChainResult[] = [];
  for (const chainId of planChainIds(plan)) {
    const expectedSender = review.chains.find((candidate) => candidate.chainId === chainId)?.sender;
    chains.push(
      await executeAndVerifyChain(
        plan,
        chainId,
        provider,
        prepared,
        expectedSender ?? null,
        observer,
        timing,
        checkpoint,
        shouldStop,
      ),
    );
  }
  return buildResult(checkpoint.record, chains);
}

async function preflightExecution(
  plan: ReviewedPlan,
  provider: MoesiExecutionProvider,
  review: ExecutionProviderReview,
  packing: ExecutionPacking,
  observer: MoesiObservationAdapter,
  retainedExecutionAncestors: readonly ExecutionAncestor[] = [],
): Promise<PreparedProviderExecution | null> {
  if (packing === "per-chain" && provider.submitBatch === undefined) {
    throw new MoesiExecutionError(
      "provider_packing_unsupported",
      "the provider cannot execute the reviewed packing",
    );
  }
  let currentReviewValue: unknown;
  try {
    currentReviewValue = await provider.review({ plan, packing });
  } catch {
    throw new MoesiExecutionError("provider_review_failed", "provider re-review failed");
  }
  let currentReview: ExecutionProviderReview;
  try {
    currentReview = parseExecutionProviderReview(currentReviewValue);
  } catch {
    throw new MoesiExecutionError("provider_review_invalid", "provider re-review is invalid");
  }
  if (
    currentReview.providerId !== provider.id ||
    hashCanonical(currentReview) !== hashCanonical(review)
  ) {
    throw new MoesiExecutionError(
      "provider_mismatch",
      "the provider decision changed since execution review",
    );
  }

  await verifyPreflightLineage(plan, retainedExecutionAncestors, observer);

  let prepared: PreparedProviderExecution | null = null;
  if (plan.steps.length > 0) {
    try {
      const value = await provider.prepare({ plan, review, packing });
      prepared = parsePreparedProviderExecution(value, provider.id, plan.planId);
    } catch {
      throw new MoesiExecutionError("provider_prepare_failed", "provider prepare failed");
    }
  }
  return prepared;
}

async function resumeAndVerify(
  provider: ProviderObserver,
  executePendingOperation: PendingOperationExecutor | null,
  observer: MoesiObservationAdapter,
  timing: ResolvedObserveTiming,
  checkpoint: RunCheckpoint,
  shouldStop: () => boolean,
): Promise<DeploymentRunResult> {
  const plan = checkpoint.record.plan;
  const review = checkpoint.record.executionReview.provider;
  const chains: RunChainResult[] = [];
  for (const chainId of planChainIds(plan)) {
    const expectedSender = review.chains.find((candidate) => candidate.chainId === chainId)?.sender;
    chains.push(
      await resumeAndVerifyChain(
        plan,
        chainId,
        provider,
        executePendingOperation,
        expectedSender ?? null,
        observer,
        timing,
        checkpoint,
        shouldStop,
      ),
    );
  }
  return buildResult(checkpoint.record, chains);
}

function planChainIds(plan: ReviewedPlan): number[] {
  return [...new Set(plan.cells.map(({ chainId }) => chainId))].sort((left, right) => left - right);
}

function buildResult(
  record: DeploymentRunRecord,
  chains: readonly RunChainResult[],
): DeploymentRunResult {
  const convergedCount = chains.filter(({ status }) => status === "converged").length;
  const status =
    convergedCount === chains.length ? "converged" : convergedCount > 0 ? "partial" : "failed";
  return deepFreeze({
    version: MOESI_RUN_RESULT_VERSION,
    runId: record.runId,
    planId: record.plan.planId,
    manifestHash: record.plan.manifestHash,
    status,
    chains,
  });
}

interface ExecutionAncestor {
  readonly chainId: number;
  readonly blockNumber: string;
  readonly blockHash: `0x${string}`;
}

async function verifyPreflightLineage(
  plan: ReviewedPlan,
  retainedExecutionAncestors: readonly ExecutionAncestor[],
  observer: MoesiObservationAdapter,
): Promise<void> {
  for (const ancestor of plan.snapshots) {
    let descendant: ChainSnapshot;
    try {
      descendant = await captureChainSnapshot(observer, ancestor.chainId);
      if (BigInt(descendant.blockNumber) < BigInt(ancestor.blockNumber)) {
        throw new Error("snapshot height moved backward");
      }
      const related = await observer.checkBlockAncestry({
        chainId: ancestor.chainId,
        ancestor,
        descendant,
      });
      if (related !== true) throw new Error("snapshot is not canonical");
    } catch {
      throw new MoesiExecutionError(
        "plan_snapshot_unverifiable",
        "the reviewed planning snapshot is no longer verifiably canonical",
      );
    }
    try {
      const retainedOnChain = retainedExecutionAncestors.filter(
        ({ chainId }) => chainId === ancestor.chainId,
      );
      for (const retained of retainedOnChain) {
        if (BigInt(descendant.blockNumber) < BigInt(retained.blockNumber)) {
          throw new MoesiExecutionError(
            "execution_ancestry_unverifiable",
            "retained execution evidence is no longer verifiably canonical",
          );
        }
        const executionRelated = await observer.checkBlockAncestry({
          chainId: retained.chainId,
          ancestor: retained,
          descendant,
        });
        if (executionRelated !== true) {
          throw new MoesiExecutionError(
            "execution_ancestry_unverifiable",
            "retained execution evidence is no longer verifiably canonical",
          );
        }
      }
    } catch {
      throw new MoesiExecutionError(
        "execution_ancestry_unverifiable",
        "retained execution evidence is no longer verifiably canonical",
      );
    }
  }
}

interface EvidenceSequence {
  readonly references: Set<string>;
  readonly evidenceIds: Set<string>;
  latestBlock: bigint;
}

function createEvidenceSequence(plan: ReviewedPlan, chainId: number): EvidenceSequence {
  const snapshot = plan.snapshots.find((candidate) => candidate.chainId === chainId);
  if (!snapshot) throw new MoesiExecutionError("plan_mismatch", "plan snapshot is missing");
  return {
    references: new Set<string>(),
    evidenceIds: new Set<string>(),
    latestBlock: BigInt(snapshot.blockNumber),
  };
}

function acceptFinalizedSequence(
  submitted: FinalizedRunOperationEvidence,
  sequence: EvidenceSequence,
): boolean {
  const reference = submitted.reference.reference;
  const evidenceId = submitted.providerEvidence.providerEvidenceId;
  const blockNumber = BigInt(submitted.providerEvidence.blockNumber);
  if (
    sequence.references.has(reference) ||
    sequence.evidenceIds.has(evidenceId) ||
    blockNumber <= sequence.latestBlock
  ) {
    return false;
  }
  sequence.references.add(reference);
  sequence.evidenceIds.add(evidenceId);
  sequence.latestBlock = blockNumber;
  return true;
}

async function executeAndVerifyChain(
  plan: ReviewedPlan,
  chainId: number,
  provider: MoesiExecutionProvider,
  prepared: PreparedProviderExecution | null,
  expectedSender: Address | null,
  observer: MoesiObservationAdapter,
  timing: ResolvedObserveTiming,
  checkpoint: RunCheckpoint,
  shouldStop: () => boolean,
): Promise<RunChainResult> {
  const operations = compileExecutionOperations(
    plan,
    checkpoint.record.executionReview.packing,
  ).filter((operation) => operation.chainId === chainId);
  const executed: RunOperationEvidence[] = [];
  const sequence = createEvidenceSequence(plan, chainId);
  let failure: RunExecutionFailure | null = null;
  if (operations.length > 0 && prepared === null) {
    throw new MoesiExecutionError("provider_prepare_failed", "steps exist without preparation");
  }
  for (const operation of operations) {
    if (shouldStop()) {
      failure = "stop-requested";
      break;
    }
    const outcome = await executeOperation(
      plan,
      operation,
      provider,
      prepared as PreparedProviderExecution,
      expectedSender,
      observer,
      timing,
      checkpoint,
      sequence,
      shouldStop,
    );
    if (outcome.submitted !== null) executed.push(outcome.submitted);
    if (outcome.kind === "failed") {
      failure = outcome.reason;
      break;
    }
  }
  return finishChain(plan, chainId, provider.id, executed, failure, observer);
}

async function resumeAndVerifyChain(
  plan: ReviewedPlan,
  chainId: number,
  provider: ProviderObserver,
  executePendingOperation: PendingOperationExecutor | null,
  expectedSender: Address | null,
  observer: MoesiObservationAdapter,
  timing: ResolvedObserveTiming,
  checkpoint: RunCheckpoint,
  shouldStop: () => boolean,
): Promise<RunChainResult> {
  const operations = compileExecutionOperations(
    plan,
    checkpoint.record.executionReview.packing,
  ).filter((operation) => operation.chainId === chainId);
  const executed: RunOperationEvidence[] = [];
  const sequence = createEvidenceSequence(plan, chainId);
  let failure: RunExecutionFailure | null = null;
  for (const operation of operations) {
    const stored = checkpoint.record.operations.find(
      ({ operationId, chainId: storedChainId }) =>
        operationId === operation.id && storedChainId === operation.chainId,
    );
    if (!stored) throw new MoesiRunError("run_record_invalid", "run operation is missing");
    if (stored.phase === "pending") {
      if (shouldStop()) {
        failure = "stop-requested";
        break;
      }
      if (executePendingOperation === null) {
        failure = "pending-execution";
        break;
      }
      const outcome = await executePendingOperation(operation, expectedSender, sequence);
      if (outcome.submitted !== null) executed.push(outcome.submitted);
      if (outcome.kind === "failed") {
        failure = outcome.reason;
        break;
      }
      continue;
    }
    if (stored.phase === "submission-requested") {
      failure = "submission-ambiguous";
      break;
    }
    // A satisfied operation is durably complete without provider evidence: its
    // postcondition already held, so nothing was submitted and nothing joins
    // the evidence sequence. Convergence verification re-reads the state.
    if (stored.phase === "satisfied") continue;
    if (stored.phase === "failed") {
      executed.push({
        operationId: stored.operationId,
        stepIds: stored.stepIds,
        reference: stored.reference,
        providerEvidence: stored.providerEvidence,
      });
      failure = stored.reason;
      break;
    }
    if (stored.phase === "finalized") {
      const finalized = {
        operationId: stored.operationId,
        stepIds: stored.stepIds,
        reference: stored.reference,
        providerEvidence: stored.providerEvidence,
      } satisfies FinalizedRunOperationEvidence;
      executed.push(finalized);
      if (!acceptFinalizedSequence(finalized, sequence)) {
        failure = "invalid-evidence";
        break;
      }
      continue;
    }
    if (shouldStop()) {
      executed.push({
        operationId: stored.operationId,
        stepIds: stored.stepIds,
        reference: stored.reference,
        providerEvidence: null,
      });
      failure = "stop-requested";
      break;
    }
    const outcome = await observeSubmittedOperation(
      plan,
      operation,
      stored,
      provider,
      expectedSender,
      timing,
      checkpoint,
      sequence,
      shouldStop,
    );
    if (outcome.submitted !== null) executed.push(outcome.submitted);
    if (outcome.kind === "failed") {
      failure = outcome.reason;
      break;
    }
  }
  return finishChain(plan, chainId, provider.id, executed, failure, observer);
}

async function finishChain(
  plan: ReviewedPlan,
  chainId: number,
  providerId: string,
  executed: readonly RunOperationEvidence[],
  failure: RunExecutionFailure | null,
  observer: MoesiObservationAdapter,
): Promise<RunChainResult> {
  if (failure !== null) {
    return deepFreeze({
      chainId,
      status: "execution-failed",
      execution: { kind: "failed", providerId, reason: failure, operations: executed },
      snapshot: null,
      cells: plan.cells.filter((cell) => cell.chainId === chainId).map(executionUnverifiedCell),
    });
  }

  const execution: RunExecutionResult =
    executed.length === 0
      ? { kind: "not-required" }
      : { kind: "finalized", providerId, operations: executed };
  const planSnapshot = plan.snapshots.find((snapshot) => snapshot.chainId === chainId);
  const convergence = await verifyChainConvergence({
    observer,
    plan,
    chainId,
    ancestryAnchors: [
      ...(planSnapshot === undefined ? [] : [planSnapshot]),
      ...executed.flatMap(({ providerEvidence }) =>
        providerEvidence === null
          ? []
          : [
              {
                blockNumber: providerEvidence.blockNumber,
                blockHash: providerEvidence.blockHash,
              },
            ],
      ),
    ],
  });
  return deepFreeze({
    chainId,
    status: convergence.status,
    execution,
    snapshot: convergence.snapshot,
    cells: convergence.cells,
  });
}

function executionUnverifiedCell(cell: ResourceCell): RunCellVerificationResult {
  return {
    resourceId: cell.resourceId,
    address: cell.address,
    expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
    storageChecks: [],
    callChecks: [],
    configurations: [],
    status: { kind: "unreadable", reason: "execution-unverified" },
  };
}

type OperationOutcome =
  | { readonly kind: "finalized"; readonly submitted: FinalizedRunOperationEvidence }
  | { readonly kind: "satisfied"; readonly submitted: null }
  | {
      readonly kind: "failed";
      readonly reason: RunExecutionFailure;
      readonly submitted: RunOperationEvidence | null;
    };

type FinalizedRunOperationEvidence = Omit<RunOperationEvidence, "providerEvidence"> & {
  readonly providerEvidence: FinalizedProviderEvidence;
};

async function executeOperation(
  plan: ReviewedPlan,
  operation: ReviewedPlanOperation,
  provider: MoesiExecutionProvider,
  prepared: PreparedProviderExecution,
  expectedSender: Address | null,
  observer: MoesiObservationAdapter,
  timing: ResolvedObserveTiming,
  checkpoint: RunCheckpoint,
  sequence: EvidenceSequence,
  shouldStop: () => boolean,
): Promise<OperationOutcome> {
  const priorDeployments = new Set<string>();
  let allSatisfied = true;
  for (const step of operation.steps) {
    if (step.kind === "configure") {
      const resource = plan.manifest.contracts.find(({ id }) => id === step.resourceId);
      const required =
        resource?.kind === "managed"
          ? resource.configuration
              .filter(({ id }) => step.configurationIds.includes(id))
              .flatMap((rule) => rule.after ?? [])
          : [];
      const peers = [...new Map(required.map((peer) => [peerKey(peer), peer])).values()];
      try {
        for (const peer of await observeConfigurationPeers(observer, peers)) {
          const reviewed = plan.peers.find((candidate) => peerKey(candidate) === peerKey(peer));
          if (
            peer.status.kind !== "available" ||
            peer.snapshot === null ||
            reviewed?.snapshot === null ||
            reviewed === undefined ||
            !(await peerSnapshotDescends(observer, peer, reviewed.snapshot))
          )
            return { kind: "failed", reason: "configuration-peer-unverified", submitted: null };
        }
      } catch {
        return { kind: "failed", reason: "configuration-peer-unverified", submitted: null };
      }
    }
    const deploymentCapabilityFailure = await verifyDeploymentCapability(
      plan,
      step,
      observer,
      checkpoint.record,
      priorDeployments,
    );
    if (deploymentCapabilityFailure !== null) {
      return { kind: "failed", reason: deploymentCapabilityFailure, submitted: null };
    }
    const configurationGate = await verifyConfigurationRuntime(
      plan,
      step,
      observer,
      checkpoint.record,
      priorDeployments,
    );
    if (configurationGate !== null && "failure" in configurationGate) {
      return { kind: "failed", reason: configurationGate.failure, submitted: null };
    }
    const satisfied =
      configurationGate !== null &&
      !priorDeployments.has(step.resourceId) &&
      (await configurationAlreadySatisfied(step, observer, configurationGate.snapshot));
    allSatisfied = allSatisfied && satisfied;
    if (step.kind === "deploy") priorDeployments.add(step.resourceId);
  }
  if (allSatisfied) {
    await checkpoint.transition(operation.id, {
      ...operationIdentity(operation),
      phase: "satisfied",
    });
    return { kind: "satisfied", submitted: null };
  }
  if (shouldStop()) {
    return { kind: "failed", reason: "stop-requested", submitted: null };
  }
  await checkpoint.transition(operation.id, {
    ...operationIdentity(operation),
    phase: "submission-requested",
  });

  let reference: ProviderExecutionReference;
  try {
    const submitted =
      checkpoint.record.executionReview.packing === "per-chain"
        ? await provider.submitBatch!({ prepared, operation })
        : await provider.submit({
            prepared,
            action: { planId: plan.planId, chainId: operation.chainId, step: operation.steps[0]! },
          });
    reference = parseProviderExecutionReference(submitted, provider.id, operation.chainId);
  } catch {
    return { kind: "failed", reason: "submission-ambiguous", submitted: null };
  }

  try {
    await checkpoint.transition(operation.id, {
      ...operationIdentity(operation),
      phase: "submitted",
      reference,
    });
  } catch (error) {
    if (error instanceof MoesiRunError && error.code === "run_record_invalid") {
      return { kind: "failed", reason: "submission-ambiguous", submitted: null };
    }
    throw error;
  }
  const stored = checkpoint.record.operations.find(
    ({ operationId, chainId }) => operationId === operation.id && chainId === operation.chainId,
  );
  if (!stored || stored.phase !== "submitted") {
    throw new MoesiRunError("run_record_invalid", "submitted run operation was not retained");
  }
  if (shouldStop()) {
    return {
      kind: "failed",
      reason: "stop-requested",
      submitted: {
        operationId: operation.id,
        stepIds: operation.steps.map(({ id }) => id),
        reference: stored.reference,
        providerEvidence: null,
      },
    };
  }
  return observeSubmittedOperation(
    plan,
    operation,
    stored,
    { id: provider.id, observe: (request) => provider.observe(request) },
    expectedSender,
    timing,
    checkpoint,
    sequence,
    shouldStop,
  );
}

type DeploymentRuntimeGateFailure =
  | "deployment-capability-mismatch"
  | "deployment-capability-unverified"
  | "deployment-prerequisite-mismatch"
  | "deployment-prerequisite-unverified";

async function verifyDeploymentCapability(
  plan: ReviewedPlan,
  step: DeploymentStep,
  observer: MoesiObservationAdapter,
  record: DeploymentRunRecord,
  priorDeployments: ReadonlySet<string>,
): Promise<DeploymentRuntimeGateFailure | null> {
  if (step.kind !== "deploy") return null;
  const resource = plan.manifest.contracts.find(({ id }) => id === step.resourceId);
  const planningSnapshot = plan.snapshots.find(({ chainId }) => chainId === step.chainId);
  if (resource?.kind !== "managed") return "deployment-capability-unverified";
  const expectedCapability = deploymentCapabilitySpec(resource.deployment);
  const capability = plan.capabilities.find(
    (candidate) => candidate.kind === expectedCapability.kind && candidate.chainId === step.chainId,
  );
  if (
    planningSnapshot === undefined ||
    capability === undefined ||
    capability.address !== expectedCapability.address ||
    capability.expectedRuntimeCodeHash !== expectedCapability.expectedRuntimeCodeHash ||
    capability.status.kind !== "available"
  ) {
    return "deployment-capability-unverified";
  }
  const finalizedAncestors = record.operations.filter(
    (
      candidate,
    ): candidate is Extract<DeploymentRunOperationRecord, { readonly phase: "finalized" }> =>
      candidate.chainId === step.chainId && candidate.phase === "finalized",
  );

  let snapshot: ChainSnapshot;
  try {
    snapshot = await captureChainSnapshot(observer, step.chainId);
    if (
      BigInt(snapshot.blockNumber) < BigInt(planningSnapshot.blockNumber) ||
      finalizedAncestors.some(
        (ancestor) => BigInt(snapshot.blockNumber) < BigInt(ancestor.providerEvidence.blockNumber),
      )
    ) {
      return "deployment-capability-unverified";
    }
    const ancestry = await Promise.all([
      observer.checkBlockAncestry({
        chainId: step.chainId,
        ancestor: planningSnapshot,
        descendant: snapshot,
      }),
      ...finalizedAncestors.map((ancestor) =>
        observer.checkBlockAncestry({
          chainId: step.chainId,
          ancestor: {
            blockNumber: ancestor.providerEvidence.blockNumber,
            blockHash: ancestor.providerEvidence.blockHash,
          },
          descendant: snapshot,
        }),
      ),
    ]);
    if (ancestry.some((related) => related !== true)) {
      return "deployment-capability-unverified";
    }
  } catch {
    return "deployment-capability-unverified";
  }

  const observed = await observeRuntimeCode(observer, {
    chainId: step.chainId,
    address: capability.address,
    snapshot,
  });
  if (observed.kind === "unreadable") return "deployment-capability-unverified";
  if (keccak256(observed.code) !== capability.expectedRuntimeCodeHash) {
    return "deployment-capability-mismatch";
  }

  for (const prerequisiteId of resource.deployment.requiresRuntime) {
    // This dependency is created earlier in the same atomic operation. Its
    // runtime is checked by convergence after the full operation finalizes.
    if (priorDeployments.has(prerequisiteId)) continue;
    const prerequisite = plan.cells.find(
      (cell) => cell.chainId === step.chainId && cell.resourceId === prerequisiteId,
    );
    if (prerequisite === undefined) return "deployment-prerequisite-unverified";
    const prerequisiteRuntime = await observeRuntimeCode(observer, {
      chainId: step.chainId,
      address: prerequisite.address,
      snapshot,
    });
    if (prerequisiteRuntime.kind === "unreadable") {
      return "deployment-prerequisite-unverified";
    }
    if (
      prerequisiteRuntime.code === "0x" ||
      keccak256(prerequisiteRuntime.code) !== prerequisite.expectedRuntimeCodeHash
    ) {
      return "deployment-prerequisite-mismatch";
    }
  }
  return null;
}

type ConfigurationRuntimeGate =
  | { readonly failure: "configuration-runtime-mismatch" | "configuration-runtime-unverified" }
  | { readonly snapshot: ChainSnapshot };

async function verifyConfigurationRuntime(
  plan: ReviewedPlan,
  step: DeploymentStep,
  observer: MoesiObservationAdapter,
  record: DeploymentRunRecord,
  priorDeployments: ReadonlySet<string>,
): Promise<ConfigurationRuntimeGate | null> {
  if (step.kind !== "configure") return null;
  const deployments = plan.steps.filter(
    (candidate) => candidate.chainId === step.chainId && candidate.kind === "deploy",
  );
  const deployedResourceIds = new Set(deployments.map(({ resourceId }) => resourceId));
  const runtimeCells = plan.cells.filter(
    (cell) =>
      cell.chainId === step.chainId &&
      (cell.resourceId === step.resourceId || deployedResourceIds.has(cell.resourceId)) &&
      !priorDeployments.has(cell.resourceId),
  );
  const planningSnapshot = plan.snapshots.find(({ chainId }) => chainId === step.chainId);
  if (
    planningSnapshot === undefined ||
    (!priorDeployments.has(step.resourceId) &&
      !runtimeCells.some(({ resourceId }) => resourceId === step.resourceId)) ||
    deployments.some((deployment) => {
      if (priorDeployments.has(deployment.resourceId)) return false;
      const stored = record.operations.find(
        (candidate) =>
          candidate.chainId === deployment.chainId && candidate.stepIds.includes(deployment.id),
      );
      return stored?.phase !== "finalized";
    })
  ) {
    return { failure: "configuration-runtime-unverified" };
  }
  const finalizedAncestors = record.operations.filter(
    (
      candidate,
    ): candidate is Extract<DeploymentRunOperationRecord, { readonly phase: "finalized" }> =>
      candidate.chainId === step.chainId && candidate.phase === "finalized",
  );

  let snapshot: ChainSnapshot;
  try {
    snapshot = await captureChainSnapshot(observer, step.chainId);
    if (
      BigInt(snapshot.blockNumber) < BigInt(planningSnapshot.blockNumber) ||
      finalizedAncestors.some(
        (ancestor) => BigInt(snapshot.blockNumber) < BigInt(ancestor.providerEvidence.blockNumber),
      )
    ) {
      return { failure: "configuration-runtime-unverified" };
    }
    const ancestry = await Promise.all([
      observer.checkBlockAncestry({
        chainId: step.chainId,
        ancestor: planningSnapshot,
        descendant: snapshot,
      }),
      ...finalizedAncestors.map((ancestor) =>
        observer.checkBlockAncestry({
          chainId: step.chainId,
          ancestor: {
            blockNumber: ancestor.providerEvidence.blockNumber,
            blockHash: ancestor.providerEvidence.blockHash,
          },
          descendant: snapshot,
        }),
      ),
    ]);
    if (ancestry.some((related) => related !== true)) {
      return { failure: "configuration-runtime-unverified" };
    }
  } catch {
    return { failure: "configuration-runtime-unverified" };
  }

  const observations = await Promise.all(
    runtimeCells.map(async (cell) => ({
      cell,
      observed: await observeRuntimeCode(observer, {
        chainId: step.chainId,
        address: cell.address,
        snapshot,
      }),
    })),
  );
  if (observations.some(({ observed }) => observed.kind === "unreadable")) {
    return { failure: "configuration-runtime-unverified" };
  }
  return observations.some(
    ({ cell, observed }) =>
      observed.kind === "readable" && keccak256(observed.code) !== cell.expectedRuntimeCodeHash,
  )
    ? { failure: "configuration-runtime-mismatch" }
    : { snapshot };
}

/**
 * True only when every reviewed static-call postcondition of the configure
 * step already reads its exact expected result at the gate's verified
 * snapshot. Unreadable or drifted reads submit the reviewed write as usual.
 */
async function configurationAlreadySatisfied(
  step: DeploymentStep,
  observer: MoesiObservationAdapter,
  snapshot: ChainSnapshot,
): Promise<boolean> {
  if (step.postconditions.length === 0) return false;
  for (const postcondition of step.postconditions) {
    if (postcondition.kind !== "static-call") return false;
    const observed = await observeCall(observer, {
      chainId: step.chainId,
      target: postcondition.target,
      data: postcondition.data,
      caller: postcondition.caller,
      snapshot,
    });
    if (observed.kind !== "readable" || observed.result !== postcondition.expectedResult) {
      return false;
    }
  }
  return true;
}

async function observeSubmittedOperation(
  plan: ReviewedPlan,
  operation: ReviewedPlanOperation,
  stored: Extract<DeploymentRunOperationRecord, { readonly phase: "submitted" }>,
  provider: ProviderObserver,
  expectedSender: Address | null,
  timing: ResolvedObserveTiming,
  checkpoint: RunCheckpoint,
  sequence: EvidenceSequence,
  shouldStop: () => boolean,
): Promise<OperationOutcome> {
  for (let attempt = 0; attempt < timing.attempts; attempt += 1) {
    if (shouldStop()) {
      return {
        kind: "failed",
        reason: "stop-requested",
        submitted: {
          operationId: operation.id,
          stepIds: operation.steps.map(({ id }) => id),
          reference: stored.reference,
          providerEvidence: null,
        },
      };
    }
    if (attempt > 0 && timing.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, timing.delayMs));
      if (shouldStop()) {
        return {
          kind: "failed",
          reason: "stop-requested",
          submitted: {
            operationId: operation.id,
            stepIds: operation.steps.map(({ id }) => id),
            reference: stored.reference,
            providerEvidence: null,
          },
        };
      }
    }
    let evidence: ProviderExecutionEvidence;
    try {
      const observed = await provider.observe({ reference: stored.reference });
      evidence = parseProviderExecutionEvidence(observed);
    } catch {
      evidence = { status: "unreadable", reason: "observation-unavailable" };
    }
    if (evidence.status === "finalized") {
      const submitted = {
        operationId: operation.id,
        stepIds: operation.steps.map(({ id }) => id),
        reference: stored.reference,
        providerEvidence: evidence.finalized,
      } satisfies FinalizedRunOperationEvidence;
      const planSnapshot = plan.snapshots.find(
        (snapshot) => snapshot.chainId === operation.chainId,
      );
      const sequenceValid = acceptFinalizedSequence(submitted, sequence);
      const evidenceValid =
        planSnapshot !== undefined &&
        BigInt(evidence.finalized.blockNumber) > BigInt(planSnapshot.blockNumber) &&
        sequenceValid;
      if (!evidenceValid) {
        await checkpoint.transition(operation.id, {
          operationId: operation.id,
          stepIds: operation.steps.map(({ id }) => id),
          chainId: operation.chainId,
          phase: "failed",
          reference: stored.reference,
          providerEvidence: evidence.finalized,
          reason: "invalid-evidence",
        });
        return { kind: "failed", reason: "invalid-evidence", submitted };
      }
      if (!finalizedCallsMatchOperation(operation, evidence.finalized, expectedSender)) {
        await checkpoint.transition(operation.id, {
          operationId: operation.id,
          stepIds: operation.steps.map(({ id }) => id),
          chainId: operation.chainId,
          phase: "failed",
          reference: stored.reference,
          providerEvidence: evidence.finalized,
          reason: "call-mismatch",
        });
        return { kind: "failed", reason: "call-mismatch", submitted };
      }
      await checkpoint.transition(operation.id, {
        operationId: operation.id,
        stepIds: operation.steps.map(({ id }) => id),
        chainId: operation.chainId,
        phase: "finalized",
        reference: stored.reference,
        providerEvidence: evidence.finalized,
      });
      return { kind: "finalized", submitted };
    }
    if (evidence.status === "failed") {
      await checkpoint.transition(operation.id, {
        operationId: operation.id,
        stepIds: operation.steps.map(({ id }) => id),
        chainId: operation.chainId,
        phase: "failed",
        reference: stored.reference,
        providerEvidence: null,
        reason: "execution-failed",
      });
      return {
        kind: "failed",
        reason: "execution-failed",
        submitted: {
          operationId: operation.id,
          stepIds: operation.steps.map(({ id }) => id),
          reference: stored.reference,
          providerEvidence: null,
        },
      };
    }
    if (evidence.status === "unreadable" && evidence.reason === "invalid-evidence") {
      await checkpoint.transition(operation.id, {
        operationId: operation.id,
        stepIds: operation.steps.map(({ id }) => id),
        chainId: operation.chainId,
        phase: "failed",
        reference: stored.reference,
        providerEvidence: null,
        reason: "invalid-evidence",
      });
      return {
        kind: "failed",
        reason: "invalid-evidence",
        submitted: {
          operationId: operation.id,
          stepIds: operation.steps.map(({ id }) => id),
          reference: stored.reference,
          providerEvidence: null,
        },
      };
    }
    // Pending or observation-unavailable remains tied to the same reference.
  }
  return {
    kind: "failed",
    reason: "execution-unresolved",
    submitted: {
      operationId: operation.id,
      stepIds: operation.steps.map(({ id }) => id),
      reference: stored.reference,
      providerEvidence: null,
    },
  };
}

function operationIdentity(operation: ReviewedPlanOperation) {
  return {
    operationId: operation.id,
    stepIds: operation.steps.map(({ id }) => id),
    chainId: operation.chainId,
  };
}
