import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  DeploymentRun,
  DeploymentRunRecord,
  DeploymentRunResult,
  ReviewedExecution,
  ReviewedPlan,
} from "moesi";

export const CLI_EXECUTION_REVIEW_VERSION = "moesi.cli-execution-review/v1" as const;
export const CLI_RUN_RESULT_VERSION = "moesi.cli-run-result/v1" as const;

export interface CliExecutionReview {
  readonly version: typeof CLI_EXECUTION_REVIEW_VERSION;
  readonly reviewId: `0x${string}`;
  readonly runStoreId: `0x${string}`;
  readonly planId: ReviewedPlan["planId"];
  readonly manifestHash: ReviewedPlan["manifestHash"];
  readonly disposition: ReviewedPlan["disposition"];
  readonly snapshots: ReviewedPlan["snapshots"];
  readonly capabilities: ReviewedPlan["capabilities"];
  readonly provider: ReviewedExecution["provider"];
  readonly atomicity: "one-transaction-per-action";
  readonly partialProgress: true;
  readonly steps: ReviewedPlan["steps"];
}

export function createCliExecutionReview(
  plan: ReviewedPlan,
  executionReview: ReviewedExecution,
  storeDirectory: string,
): CliExecutionReview {
  const runStoreId = `0x${createHash("sha256")
    .update("moesi.cli-run-store/v1\0", "utf8")
    .update(resolve(storeDirectory), "utf8")
    .digest("hex")}` as const;
  const digest = createHash("sha256")
    .update(`${CLI_EXECUTION_REVIEW_VERSION}\0`, "utf8")
    .update(JSON.stringify({ executionReview, runStoreId }), "utf8")
    .digest("hex");
  return Object.freeze({
    version: CLI_EXECUTION_REVIEW_VERSION,
    reviewId: `0x${digest}`,
    runStoreId,
    planId: plan.planId,
    manifestHash: plan.manifestHash,
    disposition: plan.disposition,
    snapshots: plan.snapshots,
    capabilities: plan.capabilities,
    provider: executionReview.provider,
    atomicity: "one-transaction-per-action",
    partialProgress: true,
    steps: plan.steps,
  });
}

export function renderExecutionReviewHuman(
  review: CliExecutionReview,
  approvalRequired: boolean,
): string {
  const lines = [
    `Moesi execution review ${review.reviewId}`,
    `run-store ${review.runStoreId}`,
    `plan ${review.planId}`,
    `manifest ${review.manifestHash}`,
    `plan-disposition ${review.disposition}`,
    `provider ${review.provider.providerId}`,
    `support ${review.provider.status}`,
    `atomicity ${review.atomicity}`,
    "partial-progress possible",
  ];
  for (const snapshot of review.snapshots) {
    lines.push(`snapshot ${snapshot.chainId} ${snapshot.blockNumber} ${snapshot.blockHash}`);
  }
  for (const capability of review.capabilities) {
    const detail =
      capability.status.kind === "available" || capability.status.kind === "bytecode-drift"
        ? ` observed=${capability.status.observedRuntimeCodeHash}`
        : capability.status.kind === "unreadable"
          ? ` reason=${capability.status.reason}`
          : "";
    lines.push(
      `capability ${capability.chainId} ${capability.kind} ${capability.status.kind} address=${capability.address} expected=${capability.expectedRuntimeCodeHash}${detail}`,
    );
  }
  for (const chain of review.provider.chains) {
    lines.push(
      `chain ${chain.chainId} sender ${chain.sender ?? "unavailable"} route ${chain.route}`,
      `enforcement ${chain.chainId} calls=${chain.enforcement.calls} expiry=${chain.enforcement.expiry} operation-count=${chain.enforcement.operationCount}`,
    );
  }
  for (const step of review.steps) {
    lines.push(
      `step ${step.chainId} ${step.id} ${step.kind} target=${step.call.target} value=${step.call.value} data=${step.call.data}`,
    );
  }
  for (const reason of review.provider.reasons) {
    lines.push(
      `reason ${reason.code} chain=${reason.chainId ?? "all"} step=${reason.stepId ?? "all"}`,
    );
  }
  lines.push("execution not-started");
  if (approvalRequired && review.provider.status === "supported") {
    lines.push(`approve --accept-review ${review.reviewId}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderExecutionReviewJson(review: CliExecutionReview): string {
  return `${JSON.stringify(review)}\n`;
}

export function renderRunHuman(
  review: CliExecutionReview,
  run: DeploymentRun,
  result: DeploymentRunResult,
  stoppedBy: "SIGINT" | "SIGTERM" | null = null,
): string {
  const lines = [
    renderExecutionReviewHuman(review, false).trimEnd(),
    `Moesi run ${result.runId}`,
    `run-state ${run.state}`,
    `result ${result.status}`,
  ];
  if (stoppedBy !== null) lines.push(`stopped-by ${stoppedBy}`);
  for (const chain of result.chains) {
    const reason = chain.execution.kind === "failed" ? ` reason=${chain.execution.reason}` : "";
    lines.push(`result-chain ${chain.chainId} ${chain.status}${reason}`);
    if (chain.execution.kind !== "not-required") {
      for (const step of chain.execution.steps) {
        lines.push(`result-step ${chain.chainId} ${step.stepId} ${step.reference.reference}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderRunJson(
  review: CliExecutionReview,
  run: DeploymentRun,
  result: DeploymentRunResult,
  stoppedBy: "SIGINT" | "SIGTERM" | null = null,
): string {
  return `${JSON.stringify({
    version: CLI_RUN_RESULT_VERSION,
    review,
    runState: run.state,
    stoppedBy,
    result,
  })}\n`;
}

export function executionReviewFromRecord(
  record: DeploymentRunRecord,
  storeDirectory: string,
): CliExecutionReview {
  return createCliExecutionReview(record.plan, record.executionReview, storeDirectory);
}
