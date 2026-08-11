import { type Address, keccak256 } from "viem";
import { MoesiExecutionError, MoesiRunError } from "../errors.js";
import type { PreparedProviderExecution } from "../execution/prepared.js";
import type { MoesiExecutionProvider } from "../execution/provider.js";
import type {
  FinalizedProviderEvidence,
  ProviderExecutionEvidence,
  ProviderExecutionReference,
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
import { captureChainSnapshot, observeRuntimeCode } from "../observation/observe.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "../observation/types.js";
import type { DeploymentRunStore } from "../persistence/store.js";
import { parseReviewedPlan } from "../planning/reviewed-plan.js";
import type { DeploymentStep, ResourceCell, ReviewedPlan } from "../planning/types.js";
import { finalizedCallsMatchStep } from "../verification/calls.js";
import { verifyChainConvergence } from "../verification/convergence.js";
import {
  createDeploymentRunRecord,
  type DeploymentRunRecord,
  type DeploymentRunStepRecord,
  deploymentRunNeedsRecovery,
  parseDeploymentRunId,
  parseDeploymentRunRecord,
  transitionDeploymentRunStep,
} from "./record.js";
import type {
  DeploymentRun,
  DeploymentRunResult,
  ObserveTiming,
  RunCellVerificationResult,
  RunChainResult,
  RunExecutionFailure,
  RunExecutionResult,
  RunStepEvidence,
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

type PendingStepExecutor = (
  step: DeploymentStep,
  expectedSender: Address | null,
  sequence: EvidenceSequence,
) => Promise<StepOutcome>;

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
 * ambiguous. Only a provably untouched `pending` step can re-run exact preflight
 * and pass through the normal durable fence before submission.
 */
export async function resumeDeploymentRun(input: ResumeDeploymentRunInput): Promise<DeploymentRun> {
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
  const executePendingStep: PendingStepExecutor = async (step, expectedSender, sequence) => {
    if (!prepared) {
      const retainedExecutionAncestors = checkpoint.record.steps.flatMap((stored) =>
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
    return executeStep(
      record.plan,
      step,
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
              executePendingStep,
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

  async transition(stepId: string, nextStep: DeploymentRunStepRecord): Promise<void> {
    const next = transitionDeploymentRunStep(this.#record, stepId, nextStep);
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
  const prepared = await preflightExecution(plan, provider, review, observer);
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
  observer: MoesiObservationAdapter,
  retainedExecutionAncestors: readonly ExecutionAncestor[] = [],
): Promise<PreparedProviderExecution | null> {
  let currentReviewValue: unknown;
  try {
    currentReviewValue = await provider.review({ plan });
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
      const value = await provider.prepare({ plan, review });
      prepared = parsePreparedProviderExecution(value, provider.id, plan.planId);
    } catch {
      throw new MoesiExecutionError("provider_prepare_failed", "provider prepare failed");
    }
  }
  return prepared;
}

async function resumeAndVerify(
  provider: ProviderObserver,
  executePendingStep: PendingStepExecutor,
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
        executePendingStep,
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
  submitted: FinalizedRunStepEvidence,
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
  const steps = plan.steps.filter((step) => step.chainId === chainId);
  const executed: RunStepEvidence[] = [];
  const sequence = createEvidenceSequence(plan, chainId);
  let failure: RunExecutionFailure | null = null;
  if (steps.length > 0 && prepared === null) {
    throw new MoesiExecutionError("provider_prepare_failed", "steps exist without preparation");
  }
  for (const step of steps) {
    if (shouldStop()) {
      failure = "stop-requested";
      break;
    }
    const outcome = await executeStep(
      plan,
      step,
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
  executePendingStep: PendingStepExecutor,
  expectedSender: Address | null,
  observer: MoesiObservationAdapter,
  timing: ResolvedObserveTiming,
  checkpoint: RunCheckpoint,
  shouldStop: () => boolean,
): Promise<RunChainResult> {
  const steps = plan.steps.filter((step) => step.chainId === chainId);
  const executed: RunStepEvidence[] = [];
  const sequence = createEvidenceSequence(plan, chainId);
  let failure: RunExecutionFailure | null = null;
  for (const step of steps) {
    const stored = checkpoint.record.steps.find(
      ({ stepId, chainId: storedChainId }) => stepId === step.id && storedChainId === step.chainId,
    );
    if (!stored) throw new MoesiRunError("run_record_invalid", "run step is missing");
    if (stored.phase === "pending") {
      if (shouldStop()) {
        failure = "stop-requested";
        break;
      }
      const outcome = await executePendingStep(step, expectedSender, sequence);
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
    if (stored.phase === "failed") {
      executed.push({
        stepId: stored.stepId,
        reference: stored.reference,
        providerEvidence: stored.providerEvidence,
      });
      failure = stored.reason;
      break;
    }
    if (stored.phase === "finalized") {
      const finalized = {
        stepId: stored.stepId,
        reference: stored.reference,
        providerEvidence: stored.providerEvidence,
      } satisfies FinalizedRunStepEvidence;
      executed.push(finalized);
      if (!acceptFinalizedSequence(finalized, sequence)) {
        failure = "invalid-evidence";
        break;
      }
      continue;
    }
    if (shouldStop()) {
      executed.push({
        stepId: stored.stepId,
        reference: stored.reference,
        providerEvidence: null,
      });
      failure = "stop-requested";
      break;
    }
    const outcome = await observeSubmittedStep(
      plan,
      step,
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
  executed: readonly RunStepEvidence[],
  failure: RunExecutionFailure | null,
  observer: MoesiObservationAdapter,
): Promise<RunChainResult> {
  if (failure !== null) {
    return deepFreeze({
      chainId,
      status: "execution-failed",
      execution: { kind: "failed", providerId, reason: failure, steps: executed },
      snapshot: null,
      cells: plan.cells.filter((cell) => cell.chainId === chainId).map(executionUnverifiedCell),
    });
  }

  const execution: RunExecutionResult =
    executed.length === 0
      ? { kind: "not-required" }
      : { kind: "finalized", providerId, steps: executed };
  const convergence = await verifyChainConvergence({
    observer,
    plan,
    chainId,
    executionAncestors: executed.flatMap(({ providerEvidence }) =>
      providerEvidence === null
        ? []
        : [
            {
              blockNumber: providerEvidence.blockNumber,
              blockHash: providerEvidence.blockHash,
            },
          ],
    ),
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

type StepOutcome =
  | { readonly kind: "finalized"; readonly submitted: FinalizedRunStepEvidence }
  | {
      readonly kind: "failed";
      readonly reason: RunExecutionFailure;
      readonly submitted: RunStepEvidence | null;
    };

type FinalizedRunStepEvidence = Omit<RunStepEvidence, "providerEvidence"> & {
  readonly providerEvidence: FinalizedProviderEvidence;
};

async function executeStep(
  plan: ReviewedPlan,
  step: DeploymentStep,
  provider: MoesiExecutionProvider,
  prepared: PreparedProviderExecution,
  expectedSender: Address | null,
  observer: MoesiObservationAdapter,
  timing: ResolvedObserveTiming,
  checkpoint: RunCheckpoint,
  sequence: EvidenceSequence,
  shouldStop: () => boolean,
): Promise<StepOutcome> {
  const deploymentCapabilityFailure = await verifyDeploymentCapability(
    plan,
    step,
    observer,
    checkpoint.record,
  );
  if (deploymentCapabilityFailure !== null) {
    return { kind: "failed", reason: deploymentCapabilityFailure, submitted: null };
  }
  const configurationRuntimeFailure = await verifyConfigurationRuntime(
    plan,
    step,
    observer,
    checkpoint.record,
  );
  if (configurationRuntimeFailure !== null) {
    return { kind: "failed", reason: configurationRuntimeFailure, submitted: null };
  }
  if (shouldStop()) {
    return { kind: "failed", reason: "stop-requested", submitted: null };
  }
  await checkpoint.transition(step.id, {
    stepId: step.id,
    chainId: step.chainId,
    phase: "submission-requested",
  });

  let reference: ProviderExecutionReference;
  try {
    const submitted = await provider.submit({
      prepared,
      action: { planId: plan.planId, chainId: step.chainId, step },
    });
    reference = parseProviderExecutionReference(submitted, provider.id, step.chainId);
  } catch {
    return { kind: "failed", reason: "submission-ambiguous", submitted: null };
  }

  try {
    await checkpoint.transition(step.id, {
      stepId: step.id,
      chainId: step.chainId,
      phase: "submitted",
      reference,
    });
  } catch (error) {
    if (error instanceof MoesiRunError && error.code === "run_record_invalid") {
      return { kind: "failed", reason: "submission-ambiguous", submitted: null };
    }
    throw error;
  }
  const stored = checkpoint.record.steps.find(
    ({ stepId, chainId }) => stepId === step.id && chainId === step.chainId,
  );
  if (!stored || stored.phase !== "submitted") {
    throw new MoesiRunError("run_record_invalid", "submitted run step was not retained");
  }
  if (shouldStop()) {
    return {
      kind: "failed",
      reason: "stop-requested",
      submitted: { stepId: step.id, reference: stored.reference, providerEvidence: null },
    };
  }
  return observeSubmittedStep(
    plan,
    step,
    stored,
    { id: provider.id, observe: (request) => provider.observe(request) },
    expectedSender,
    timing,
    checkpoint,
    sequence,
    shouldStop,
  );
}

type DeploymentCapabilityFailure =
  | "deployment-capability-mismatch"
  | "deployment-capability-unverified";

async function verifyDeploymentCapability(
  plan: ReviewedPlan,
  step: DeploymentStep,
  observer: MoesiObservationAdapter,
  record: DeploymentRunRecord,
): Promise<DeploymentCapabilityFailure | null> {
  if (step.kind !== "deploy") return null;
  const planningSnapshot = plan.snapshots.find(({ chainId }) => chainId === step.chainId);
  const capability = plan.capabilities.find(
    (candidate) => candidate.kind === "create2-factory-v1" && candidate.chainId === step.chainId,
  );
  if (
    planningSnapshot === undefined ||
    capability === undefined ||
    capability.status.kind !== "available"
  ) {
    return "deployment-capability-unverified";
  }
  const finalizedAncestors = record.steps.filter(
    (candidate): candidate is Extract<DeploymentRunStepRecord, { readonly phase: "finalized" }> =>
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
  return keccak256(observed.code) === capability.expectedRuntimeCodeHash
    ? null
    : "deployment-capability-mismatch";
}

async function verifyConfigurationRuntime(
  plan: ReviewedPlan,
  step: DeploymentStep,
  observer: MoesiObservationAdapter,
  record: DeploymentRunRecord,
): Promise<"configuration-runtime-mismatch" | "configuration-runtime-unverified" | null> {
  if (step.kind !== "configure") return null;
  const deployments = plan.steps.filter(
    (candidate) => candidate.chainId === step.chainId && candidate.kind === "deploy",
  );
  const deployedResourceIds = new Set(deployments.map(({ resourceId }) => resourceId));
  const runtimeCells = plan.cells.filter(
    (cell) =>
      cell.chainId === step.chainId &&
      (cell.resourceId === step.resourceId || deployedResourceIds.has(cell.resourceId)),
  );
  const planningSnapshot = plan.snapshots.find(({ chainId }) => chainId === step.chainId);
  if (
    planningSnapshot === undefined ||
    !runtimeCells.some(({ resourceId }) => resourceId === step.resourceId) ||
    deployments.some((deployment) => {
      const stored = record.steps.find(
        (candidate) =>
          candidate.chainId === deployment.chainId && candidate.stepId === deployment.id,
      );
      return stored?.phase !== "finalized";
    })
  ) {
    return "configuration-runtime-unverified";
  }
  const finalizedAncestors = record.steps.filter(
    (candidate): candidate is Extract<DeploymentRunStepRecord, { readonly phase: "finalized" }> =>
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
      return "configuration-runtime-unverified";
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
      return "configuration-runtime-unverified";
    }
  } catch {
    return "configuration-runtime-unverified";
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
    return "configuration-runtime-unverified";
  }
  return observations.some(
    ({ cell, observed }) =>
      observed.kind === "readable" && keccak256(observed.code) !== cell.expectedRuntimeCodeHash,
  )
    ? "configuration-runtime-mismatch"
    : null;
}

async function observeSubmittedStep(
  plan: ReviewedPlan,
  step: DeploymentStep,
  stored: Extract<DeploymentRunStepRecord, { readonly phase: "submitted" }>,
  provider: ProviderObserver,
  expectedSender: Address | null,
  timing: ResolvedObserveTiming,
  checkpoint: RunCheckpoint,
  sequence: EvidenceSequence,
  shouldStop: () => boolean,
): Promise<StepOutcome> {
  for (let attempt = 0; attempt < timing.attempts; attempt += 1) {
    if (shouldStop()) {
      return {
        kind: "failed",
        reason: "stop-requested",
        submitted: { stepId: step.id, reference: stored.reference, providerEvidence: null },
      };
    }
    if (attempt > 0 && timing.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, timing.delayMs));
      if (shouldStop()) {
        return {
          kind: "failed",
          reason: "stop-requested",
          submitted: { stepId: step.id, reference: stored.reference, providerEvidence: null },
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
        stepId: step.id,
        reference: stored.reference,
        providerEvidence: evidence.finalized,
      } satisfies FinalizedRunStepEvidence;
      const planSnapshot = plan.snapshots.find((snapshot) => snapshot.chainId === step.chainId);
      const sequenceValid = acceptFinalizedSequence(submitted, sequence);
      const evidenceValid =
        planSnapshot !== undefined &&
        BigInt(evidence.finalized.blockNumber) > BigInt(planSnapshot.blockNumber) &&
        sequenceValid;
      if (!evidenceValid) {
        await checkpoint.transition(step.id, {
          stepId: step.id,
          chainId: step.chainId,
          phase: "failed",
          reference: stored.reference,
          providerEvidence: evidence.finalized,
          reason: "invalid-evidence",
        });
        return { kind: "failed", reason: "invalid-evidence", submitted };
      }
      if (!finalizedCallsMatchStep(step, evidence.finalized, expectedSender)) {
        await checkpoint.transition(step.id, {
          stepId: step.id,
          chainId: step.chainId,
          phase: "failed",
          reference: stored.reference,
          providerEvidence: evidence.finalized,
          reason: "call-mismatch",
        });
        return { kind: "failed", reason: "call-mismatch", submitted };
      }
      await checkpoint.transition(step.id, {
        stepId: step.id,
        chainId: step.chainId,
        phase: "finalized",
        reference: stored.reference,
        providerEvidence: evidence.finalized,
      });
      return { kind: "finalized", submitted };
    }
    if (evidence.status === "failed") {
      await checkpoint.transition(step.id, {
        stepId: step.id,
        chainId: step.chainId,
        phase: "failed",
        reference: stored.reference,
        providerEvidence: null,
        reason: "execution-failed",
      });
      return {
        kind: "failed",
        reason: "execution-failed",
        submitted: { stepId: step.id, reference: stored.reference, providerEvidence: null },
      };
    }
    if (evidence.status === "unreadable" && evidence.reason === "invalid-evidence") {
      await checkpoint.transition(step.id, {
        stepId: step.id,
        chainId: step.chainId,
        phase: "failed",
        reference: stored.reference,
        providerEvidence: null,
        reason: "invalid-evidence",
      });
      return {
        kind: "failed",
        reason: "invalid-evidence",
        submitted: { stepId: step.id, reference: stored.reference, providerEvidence: null },
      };
    }
    // Pending or observation-unavailable remains tied to the same reference.
  }
  return {
    kind: "failed",
    reason: "execution-unresolved",
    submitted: { stepId: step.id, reference: stored.reference, providerEvidence: null },
  };
}
