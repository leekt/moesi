import { MoesiRunError } from "../errors.js";
import type {
  FinalizedProviderEvidence,
  ProviderExecutionReference,
} from "../execution/reference.js";
import type { ReviewedExecution } from "../execution/review.js";
import {
  parseProviderExecutionEvidence,
  parseProviderExecutionReference,
  parseReviewedExecution,
  validateProviderReviewForPlan,
} from "../execution/validate.js";
import { deepFreeze, hashCanonical, snapshotArray } from "../internal.js";
import { parseReviewedPlan } from "../planning/reviewed-plan.js";
import type { ReviewedPlan } from "../planning/types.js";
import { finalizedCallsMatchStep } from "../verification/calls.js";

export const MOESI_DEPLOYMENT_RUN_VERSION = "moesi.deployment-run/v2" as const;

interface RunStepIdentity {
  readonly stepId: string;
  readonly chainId: number;
}

export type DeploymentRunStepRecord =
  | (RunStepIdentity & { readonly phase: "pending" })
  | (RunStepIdentity & { readonly phase: "submission-requested" })
  | (RunStepIdentity & {
      readonly phase: "submitted";
      readonly reference: ProviderExecutionReference;
    })
  | (RunStepIdentity & {
      readonly phase: "finalized";
      readonly reference: ProviderExecutionReference;
      readonly providerEvidence: FinalizedProviderEvidence;
    })
  | (RunStepIdentity & {
      readonly phase: "failed";
      readonly reference: ProviderExecutionReference;
      readonly providerEvidence: FinalizedProviderEvidence | null;
      readonly reason: "execution-failed" | "invalid-evidence" | "call-mismatch";
    });

/**
 * Current durable run schema. The exact reviewed plan and provider decision are
 * immutable. Only Moesi-owned step phases, opaque provider references, and
 * finalized provider evidence evolve. Prepared bindings and provider lifecycle
 * state are deliberately absent.
 */
export interface DeploymentRunRecord {
  readonly version: "moesi.deployment-run/v2";
  readonly runId: string;
  readonly revision: number;
  readonly plan: ReviewedPlan;
  readonly executionReview: ReviewedExecution;
  readonly providerId: string;
  readonly steps: readonly DeploymentRunStepRecord[];
}

const RUN_ID_PATTERN = /^0x[0-9a-f]{64}$/;
const TERMINAL_FAILURES = new Set(["execution-failed", "invalid-evidence", "call-mismatch"]);

function fail(code: MoesiRunError["code"], message: string): never {
  throw new MoesiRunError(code, message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) snapshot[key] = Reflect.get(value, key);
    return snapshot;
  } catch {
    return null;
  }
}

function hasExactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return (
    Object.keys(record).every((key) => expected.has(key)) &&
    allowed.length === Object.keys(record).length
  );
}

function parseFinalizedEvidence(value: unknown): FinalizedProviderEvidence {
  const parsed = parseProviderExecutionEvidence({ status: "finalized", finalized: value });
  if (parsed.status !== "finalized") fail("run_record_invalid", "run provider evidence is invalid");
  return parsed.finalized;
}

export function parseDeploymentRunId(input: unknown): string {
  if (typeof input !== "string" || !RUN_ID_PATTERN.test(input)) {
    return fail("run_record_invalid", "deployment run id is invalid");
  }
  return input;
}

function parseStepRecord(
  value: unknown,
  plan: ReviewedPlan,
  executionReview: ReviewedExecution,
  index: number,
): DeploymentRunStepRecord {
  const record = asRecord(value);
  const plannedStep = plan.steps[index];
  if (record === null || plannedStep === undefined) {
    return fail("run_record_invalid", "run step is invalid");
  }
  if (record.stepId !== plannedStep.id || record.chainId !== plannedStep.chainId) {
    return fail("run_record_invalid", "run step identity does not match the reviewed plan");
  }
  const identity = { stepId: plannedStep.id, chainId: plannedStep.chainId } as const;
  if (record.phase === "pending" || record.phase === "submission-requested") {
    if (!hasExactKeys(record, ["stepId", "chainId", "phase"])) {
      return fail("run_record_invalid", "run step phase has unexpected fields");
    }
    return Object.freeze({ ...identity, phase: record.phase });
  }
  if (record.phase === "submitted") {
    if (!hasExactKeys(record, ["stepId", "chainId", "phase", "reference"])) {
      return fail("run_record_invalid", "submitted run step has unexpected fields");
    }
    const reference = parseProviderExecutionReference(
      record.reference,
      executionReview.provider.providerId,
      plannedStep.chainId,
    );
    return Object.freeze({ ...identity, phase: "submitted", reference });
  }
  if (record.phase === "finalized") {
    if (!hasExactKeys(record, ["stepId", "chainId", "phase", "reference", "providerEvidence"])) {
      return fail("run_record_invalid", "finalized run step has unexpected fields");
    }
    const reference = parseProviderExecutionReference(
      record.reference,
      executionReview.provider.providerId,
      plannedStep.chainId,
    );
    const providerEvidence = parseFinalizedEvidence(record.providerEvidence);
    const planSnapshot = plan.snapshots.find(({ chainId }) => chainId === plannedStep.chainId);
    if (
      planSnapshot === undefined ||
      BigInt(providerEvidence.blockNumber) <= BigInt(planSnapshot.blockNumber)
    ) {
      return fail("run_record_invalid", "finalized run evidence predates its reviewed snapshot");
    }
    const expectedSender = executionReview.provider.chains.find(
      ({ chainId }) => chainId === plannedStep.chainId,
    )?.sender;
    if (!finalizedCallsMatchStep(plannedStep, providerEvidence, expectedSender ?? null)) {
      return fail("run_record_invalid", "finalized run evidence contradicts the reviewed step");
    }
    return Object.freeze({
      ...identity,
      phase: "finalized",
      reference,
      providerEvidence,
    });
  }
  if (record.phase === "failed") {
    if (
      !hasExactKeys(record, [
        "stepId",
        "chainId",
        "phase",
        "reference",
        "providerEvidence",
        "reason",
      ]) ||
      typeof record.reason !== "string" ||
      !TERMINAL_FAILURES.has(record.reason)
    ) {
      return fail("run_record_invalid", "failed run step is invalid");
    }
    const reference = parseProviderExecutionReference(
      record.reference,
      executionReview.provider.providerId,
      plannedStep.chainId,
    );
    const providerEvidence =
      record.providerEvidence === null ? null : parseFinalizedEvidence(record.providerEvidence);
    return Object.freeze({
      ...identity,
      phase: "failed",
      reference,
      providerEvidence,
      reason: record.reason as "execution-failed" | "invalid-evidence" | "call-mismatch",
    });
  }
  return fail("run_record_invalid", "run step phase is invalid");
}

/** Validate an untrusted store value into the one current immutable schema. */
export function parseDeploymentRunRecord(input: unknown): DeploymentRunRecord {
  try {
    const record = asRecord(input);
    if (
      record === null ||
      !hasExactKeys(record, [
        "version",
        "runId",
        "revision",
        "plan",
        "executionReview",
        "providerId",
        "steps",
      ]) ||
      record.version !== MOESI_DEPLOYMENT_RUN_VERSION ||
      typeof record.revision !== "number" ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0
    ) {
      return fail("run_record_invalid", "deployment run record is invalid");
    }
    const runId = parseDeploymentRunId(record.runId);
    const plan = parseReviewedPlan(record.plan as ReviewedPlan);
    const executionReview = parseReviewedExecution(record.executionReview);
    const providerId = record.providerId;
    if (executionReview.planId !== plan.planId) {
      return fail("run_plan_mismatch", "run execution review does not belong to its plan");
    }
    if (runId !== plan.planId) {
      return fail("run_plan_mismatch", "run id must equal the exact reviewed plan id");
    }
    if (typeof providerId !== "string" || providerId !== executionReview.provider.providerId) {
      return fail("run_provider_mismatch", "run provider does not match its execution review");
    }
    const validatedReview = validateProviderReviewForPlan(plan, executionReview.provider);
    if (
      validatedReview.status !== "supported" ||
      hashCanonical(validatedReview) !== hashCanonical(executionReview.provider)
    ) {
      return fail("run_record_invalid", "run execution review is not valid for its plan");
    }
    if (!Array.isArray(record.steps) || Reflect.get(record.steps, "length") !== plan.steps.length) {
      return fail("run_record_invalid", "run steps do not match the reviewed plan");
    }
    const entries = snapshotArray(record.steps);
    if (entries === null) return fail("run_record_invalid", "run steps are unreadable");
    const steps = entries.map((entry, index) =>
      parseStepRecord(entry, plan, executionReview, index),
    );
    const references = new Set<string>();
    const evidenceIds = new Set<string>();
    const latestFinalizedBlocks = new Map(
      plan.snapshots.map(({ chainId, blockNumber }) => [chainId, BigInt(blockNumber)]),
    );
    for (const step of steps) {
      if (step.phase === "pending" || step.phase === "submission-requested") continue;
      const referenceKey = `${step.chainId}:${step.reference.reference}`;
      if (references.has(referenceKey)) {
        return fail("run_record_invalid", "run repeats a provider reference");
      }
      references.add(referenceKey);
      if (step.phase !== "finalized") continue;
      const evidenceKey = `${step.chainId}:${step.providerEvidence.providerEvidenceId}`;
      const blockNumber = BigInt(step.providerEvidence.blockNumber);
      const latestBlock = latestFinalizedBlocks.get(step.chainId);
      if (evidenceIds.has(evidenceKey) || latestBlock === undefined || blockNumber <= latestBlock) {
        return fail("run_record_invalid", "run finalized evidence sequence is invalid");
      }
      evidenceIds.add(evidenceKey);
      latestFinalizedBlocks.set(step.chainId, blockNumber);
    }
    const blockedChains = new Set<number>();
    for (const step of steps) {
      if (blockedChains.has(step.chainId) && step.phase !== "pending") {
        return fail("run_record_invalid", "run advanced a step before its predecessor finalized");
      }
      if (step.phase !== "finalized") blockedChains.add(step.chainId);
    }
    return deepFreeze({
      version: MOESI_DEPLOYMENT_RUN_VERSION,
      runId,
      revision: record.revision,
      plan,
      executionReview,
      providerId,
      steps,
    });
  } catch (error) {
    if (error instanceof MoesiRunError) throw error;
    throw new MoesiRunError("run_record_invalid", "deployment run record is invalid");
  }
}

export function createDeploymentRunRecord(input: {
  readonly plan: ReviewedPlan;
  readonly executionReview: ReviewedExecution;
}): DeploymentRunRecord {
  return parseDeploymentRunRecord({
    version: MOESI_DEPLOYMENT_RUN_VERSION,
    runId: input.plan.planId,
    revision: 0,
    plan: input.plan,
    executionReview: input.executionReview,
    providerId: input.executionReview.provider.providerId,
    steps: input.plan.steps.map(({ id, chainId }) => ({
      stepId: id,
      chainId,
      phase: "pending",
    })),
  });
}

function transitionAllowed(
  existing: DeploymentRunStepRecord,
  next: DeploymentRunStepRecord,
): boolean {
  if (existing.phase === "pending") return next.phase === "submission-requested";
  if (existing.phase === "submission-requested") return next.phase === "submitted";
  if (existing.phase === "submitted") {
    return (
      (next.phase === "finalized" || next.phase === "failed") &&
      hashCanonical(existing.reference) === hashCanonical(next.reference)
    );
  }
  return false;
}

/** Shared compare-and-swap and monotonic-evolution invariant for every store. */
export function assertDeploymentRunEvolution(existingInput: unknown, nextInput: unknown): void {
  const existing = parseDeploymentRunRecord(existingInput);
  const next = parseDeploymentRunRecord(nextInput);
  if (next.revision !== existing.revision + 1) {
    fail("run_store_conflict", "run revision must advance by exactly one");
  }
  for (const field of ["version", "runId", "providerId"] as const) {
    if (existing[field] !== next[field]) {
      fail("run_store_conflict", `run attempted to rewrite immutable ${field}`);
    }
  }
  if (
    hashCanonical(existing.plan) !== hashCanonical(next.plan) ||
    hashCanonical(existing.executionReview) !== hashCanonical(next.executionReview) ||
    existing.steps.length !== next.steps.length
  ) {
    fail("run_store_conflict", "run attempted to rewrite immutable reviewed input");
  }
  let changed = 0;
  for (let index = 0; index < existing.steps.length; index += 1) {
    const before = existing.steps[index] as DeploymentRunStepRecord;
    const after = next.steps[index] as DeploymentRunStepRecord;
    if (hashCanonical(before) === hashCanonical(after)) continue;
    changed += 1;
    if (
      before.stepId !== after.stepId ||
      before.chainId !== after.chainId ||
      !transitionAllowed(before, after)
    ) {
      fail("run_store_conflict", "run step transition is not monotonic");
    }
  }
  if (changed !== 1) {
    fail("run_store_conflict", "one run revision must advance exactly one step");
  }
}

/** Build one validated next revision for a single durable step transition. */
export function transitionDeploymentRunStep(
  recordInput: DeploymentRunRecord,
  stepId: string,
  nextStep: DeploymentRunStepRecord,
): DeploymentRunRecord {
  const record = parseDeploymentRunRecord(recordInput);
  const index = record.steps.findIndex(
    (step) => step.stepId === stepId && step.chainId === nextStep.chainId,
  );
  if (index < 0 || nextStep.stepId !== stepId) {
    return fail("run_record_invalid", "run step transition target is invalid");
  }
  const steps = [...record.steps];
  steps[index] = nextStep;
  const next = parseDeploymentRunRecord({ ...record, revision: record.revision + 1, steps });
  assertDeploymentRunEvolution(record, next);
  return next;
}

export function deploymentRunNeedsRecovery(record: DeploymentRunRecord): boolean {
  const blockedChains = new Set<number>();
  for (const step of record.steps) {
    if (blockedChains.has(step.chainId) || step.phase === "finalized") continue;
    blockedChains.add(step.chainId);
    if (
      step.phase === "pending" ||
      step.phase === "submission-requested" ||
      step.phase === "submitted"
    ) {
      return true;
    }
  }
  return false;
}
