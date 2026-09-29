import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  ContractResource,
  DeploymentRun,
  DeploymentRunRecord,
  DeploymentRunResult,
  ManagedDeployment,
  ResourceCell,
  ReviewedExecution,
  ReviewedPlan,
} from "moesi";
import { callCheckEvidence, configurationEvidence, storageCheckEvidence } from "./cell-evidence.js";
import { planGuidance, providerGuidance, runRecovery } from "./guidance.js";

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
  readonly resources: readonly {
    readonly chainId: number;
    readonly resourceId: string;
    readonly address: ResourceCell["address"];
    readonly resourceKind: ContractResource["kind"];
    readonly expectedRuntimeCodeHash: ResourceCell["expectedRuntimeCodeHash"];
    readonly status: ResourceCell["status"];
    readonly configuration: ResourceCell["configuration"];
    readonly checks: ResourceCell["checks"];
    readonly storageChecks: ResourceCell["storageChecks"];
    readonly deployment: "scheduled" | "blocked" | "not-required";
    readonly deploymentStrategy: ManagedDeployment["kind"] | null;
    readonly requiresRuntime: readonly string[];
  }[];
  readonly steps: ReviewedPlan["steps"];
}

export function createCliExecutionReview(
  plan: ReviewedPlan,
  executionReview: ReviewedExecution,
  storeDirectory: string,
): CliExecutionReview {
  const resourcesById = new Map(
    plan.manifest.contracts.map((resource) => [resource.id, resource] as const),
  );
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
    resources: Object.freeze(
      plan.cells.map((cell) => {
        const resource = resourcesById.get(cell.resourceId);
        if (resource === undefined) {
          throw new Error("reviewed plan cell has no manifest resource");
        }
        const deployment: "scheduled" | "blocked" | "not-required" =
          resource.kind === "managed" && cell.status.kind === "missing"
            ? plan.steps.some(
                (step) =>
                  step.chainId === cell.chainId &&
                  step.resourceId === cell.resourceId &&
                  step.kind === "deploy",
              )
              ? "scheduled"
              : "blocked"
            : "not-required";
        return Object.freeze({
          chainId: cell.chainId,
          resourceId: cell.resourceId,
          address: cell.address,
          resourceKind: resource.kind,
          expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
          status: cell.status,
          configuration: Object.freeze(
            cell.configuration.map((configuration) => Object.freeze({ ...configuration })),
          ),
          checks: Object.freeze(cell.checks.map((check) => Object.freeze({ ...check }))),
          storageChecks: Object.freeze(
            cell.storageChecks.map((check) => Object.freeze({ ...check })),
          ),
          deployment,
          deploymentStrategy: resource.kind === "managed" ? resource.deployment.kind : null,
          requiresRuntime: Object.freeze(
            resource.kind === "managed" ? [...resource.deployment.requiresRuntime] : [],
          ),
        });
      }),
    ),
    steps: plan.steps,
  });
}

export function renderExecutionReviewHuman(
  review: CliExecutionReview,
  approvalRequired: boolean,
): string {
  const lines = [
    `Moesi execution review ${review.reviewId}`,
    "Review only. No run has been created and no transaction has been submitted.",
    planGuidance(review.disposition),
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
  for (const resource of review.resources) {
    const evidence =
      resource.status.kind === "converged" ||
      resource.status.kind === "drift" ||
      resource.status.kind === "bytecode-drift"
        ? ` observed=${resource.status.observedRuntimeCodeHash}`
        : resource.status.kind === "unreadable"
          ? ` source=${resource.status.source} id=${resource.status.id ?? "none"} reason=${resource.status.reason}${"observedRuntimeCodeHash" in resource.status ? ` observed=${resource.status.observedRuntimeCodeHash}` : ""}`
          : "";
    const mode =
      resource.resourceKind === "external" ? " mode=verify-only execution-authority=none" : "";
    const prerequisites =
      resource.resourceKind === "managed"
        ? ` deployment=${resource.deployment} requires-runtime=${resource.requiresRuntime.join(",") || "none"} strategy=${resource.deploymentStrategy}`
        : "";
    lines.push(
      `resource ${resource.chainId} ${resource.resourceId} ${resource.address} ${resource.status.kind} kind=${resource.resourceKind} expected=${resource.expectedRuntimeCodeHash}${evidence}${prerequisites}${mode}`,
    );
    for (const check of resource.storageChecks) {
      lines.push(
        `storage-check ${resource.chainId} ${resource.resourceId} ${check.id} slot=${check.slot} expected=${check.expectedWord} remediation=none execution-authority=none`,
        formatStorageReviewEvidence(resource, check),
      );
    }
    for (const check of resource.checks) {
      lines.push(
        `call-check ${resource.chainId} ${resource.resourceId} ${check.id} simulation-caller=${check.caller} readData=${check.readData} expected=${check.expectedResult} remediation=none execution-authority=none`,
        formatCallReviewEvidence(resource, check),
      );
    }
    for (const configuration of resource.configuration) {
      lines.push(
        `configuration ${resource.chainId} ${resource.resourceId} ${configuration.id} simulation-caller=${configuration.caller} readData=${configuration.readData} expected=${configuration.expectedResult} remediation=write-action`,
        formatConfigurationReviewEvidence(resource, configuration),
      );
    }
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
      providerGuidance(reason.code),
    );
  }
  lines.push("execution not-started");
  if (approvalRequired && review.provider.status === "supported") {
    lines.push("To approve, repeat the same apply command and add the following option:");
    lines.push(`  --accept-review ${review.reviewId}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderExecutionReviewJson(review: CliExecutionReview): string {
  return `${JSON.stringify(review)}\n`;
}

function formatCallReviewEvidence(
  resource: CliExecutionReview["resources"][number],
  check: ResourceCell["checks"][number],
): string {
  const detail = `simulation-caller=${check.caller} readData=${check.readData} expected=${check.expectedResult}`;
  const boundary = "remediation=none execution-authority=none";
  const evidence = callCheckEvidence(resource, check.id);
  const label = evidence.kind === "drifted" ? "call-check-mismatch" : "call-check-observation";
  return `${label} ${resource.chainId} ${resource.resourceId} ${check.id} status=${evidence.kind} ${detail} observed=${evidence.observed}${formatEvidenceReason(evidence)} ${boundary}`;
}

function formatStorageReviewEvidence(
  resource: CliExecutionReview["resources"][number],
  check: ResourceCell["storageChecks"][number],
): string {
  const detail = `slot=${check.slot} expected=${check.expectedWord}`;
  const boundary = "remediation=none execution-authority=none";
  const evidence = storageCheckEvidence(resource, check.id);
  const label =
    evidence.kind === "drifted" ? "storage-check-mismatch" : "storage-check-observation";
  return `${label} ${resource.chainId} ${resource.resourceId} ${check.id} status=${evidence.kind} ${detail} observed=${evidence.observed}${formatEvidenceReason(evidence)} ${boundary}`;
}

function formatConfigurationReviewEvidence(
  resource: CliExecutionReview["resources"][number],
  configuration: ResourceCell["configuration"][number],
): string {
  const detail = `simulation-caller=${configuration.caller} readData=${configuration.readData} expected=${configuration.expectedResult}`;
  const evidence = configurationEvidence(resource, configuration.id);
  const label =
    evidence.kind === "drifted" ? "configuration-mismatch" : "configuration-observation";
  return `${label} ${resource.chainId} ${resource.resourceId} ${configuration.id} status=${evidence.kind} ${detail} observed=${evidence.observed}${formatEvidenceReason(evidence)} remediation=write-action`;
}

function formatEvidenceReason(
  evidence: ReturnType<
    typeof callCheckEvidence | typeof storageCheckEvidence | typeof configurationEvidence
  >,
): string {
  return evidence.kind === "unreadable" ? ` reason=${evidence.reason}` : "";
}

export function renderRunHuman(
  review: CliExecutionReview,
  run: DeploymentRun,
  result: DeploymentRunResult,
  stoppedBy: "SIGINT" | "SIGTERM" | null = null,
): string {
  const lines = [
    `Moesi run ${result.runId}`,
    `run-state ${run.state}`,
    `result ${result.status}`,
    `plan ${review.planId}`,
    `provider ${review.provider.providerId}`,
    `accepted-review ${review.reviewId}`,
  ];
  if (result.status === "converged") {
    lines.push("Fresh chain observation confirms that all reviewed resources match the manifest.");
  } else {
    lines.push(
      "The deployment has not fully converged. Review the chain results and recovery steps below.",
    );
  }
  if (stoppedBy !== null) lines.push(`stopped-by ${stoppedBy}`);
  for (const chain of result.chains) {
    const reason = chain.execution.kind === "failed" ? ` reason=${chain.execution.reason}` : "";
    lines.push(`result-chain ${chain.chainId} ${chain.status}${reason}`);
    if (chain.execution.kind === "failed") lines.push(runRecovery(chain.execution.reason));
    if (chain.status === "drifted") {
      lines.push(
        "Fresh verification found drift. Inspect the resource evidence, then create and review a new plan for remaining work.",
      );
    }
    if (chain.status === "unreadable") {
      lines.push(
        "Fresh verification could not read all required evidence. Check the RPC and use verify or resume; unreadable state does not prove drift.",
      );
    }
    if (chain.execution.kind !== "not-required") {
      for (const step of chain.execution.steps) {
        lines.push(`result-step ${chain.chainId} ${step.stepId} ${step.reference.reference}`);
      }
    }
    for (const cell of chain.cells) {
      const evidence =
        cell.status.kind === "unreadable"
          ? `reason=${cell.status.reason}`
          : `expected=${cell.expectedRuntimeCodeHash} observed=${cell.status.observedRuntimeCodeHash}`;
      lines.push(
        `result-resource ${chain.chainId} ${cell.resourceId} ${cell.status.kind} address=${cell.address} ${evidence}`,
      );
      for (const check of [...cell.callChecks, ...cell.configurations]) {
        const detail =
          check.status.kind === "unreadable"
            ? `reason=${check.status.reason}`
            : `observed=${check.status.observedResult}`;
        const kind = cell.callChecks.includes(check) ? "call-check" : "configuration";
        lines.push(
          `result-${kind} ${chain.chainId} ${cell.resourceId} ${check.id} ${check.status.kind} expected=${check.expectedResult} ${detail}`,
        );
      }
      for (const check of cell.storageChecks) {
        const detail =
          check.status.kind === "unreadable"
            ? `reason=${check.status.reason}`
            : `observed=${check.status.observedWord}`;
        lines.push(
          `result-storage-check ${chain.chainId} ${cell.resourceId} ${check.id} ${check.status.kind} slot=${check.slot} expected=${check.expectedWord} ${detail}`,
        );
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
