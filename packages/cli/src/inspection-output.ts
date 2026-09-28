import type {
  DeploymentCall,
  DeploymentPostcondition,
  ManifestEnforcement,
  ManifestSender,
  PlanEnforcement,
  PlanSender,
  ReviewedPlan,
  StepSender,
} from "moesi";
import { callCheckEvidence, configurationEvidence, storageCheckEvidence } from "./cell-evidence.js";
import { formatSemanticCheck } from "./semantic-output.js";

/** One current version for the CLI plan artifact: writers and reader share it. */
export const CLI_PLAN_VERSION = "moesi.cli-plan/v4" as const;

/** The one serializer for the CLI plan artifact, shared by plan and inspect. */
export function renderPlanArtifact(plan: ReviewedPlan): string {
  return `${JSON.stringify({ version: CLI_PLAN_VERSION, plan })}\n`;
}

export function renderInspectionJson(plan: ReviewedPlan): string {
  return renderPlanArtifact(plan);
}

export function renderInspectionHuman(plan: ReviewedPlan): string {
  const lines = [
    `Moesi reviewed plan ${plan.planId}`,
    `version ${plan.version}`,
    `disposition ${plan.disposition}`,
    `manifest-hash ${plan.manifestHash}`,
    `manifest ${plan.manifest.version}`,
    `manifest contracts ${plan.manifest.contracts.length}`,
  ];

  for (const contract of plan.manifest.contracts) {
    const prefix = `manifest contract ${contract.id}`;
    lines.push(`${prefix} runtime expected=${contract.expectedRuntimeCodeHash}`);
    if (contract.kind === "external") {
      lines.push(
        `${prefix} kind=external address=${contract.address} mode=verify-only execution-authority=none`,
      );
    } else {
      const deploymentInput =
        contract.deployment.kind === "create2-factory-v1"
          ? `salt=${contract.deployment.salt}`
          : `entropy=${contract.deployment.entropy}`;
      lines.push(
        `${prefix} kind=managed`,
        `${prefix} deployment kind=${contract.deployment.kind} ${deploymentInput} initCode=${contract.deployment.initCode} value=${contract.deployment.value} requiresRuntime=${contract.deployment.requiresRuntime.join(",") || "none"}`,
        `${prefix} sender ${formatManifestSender(contract.sender)}`,
        `${prefix} enforcement ${formatManifestEnforcement(contract.enforcement)}`,
        `${prefix} configurations ${contract.configuration.length}`,
      );
      for (const prerequisite of contract.deployment.requiresRuntime) {
        lines.push(
          `manifest-deployment-runtime-prerequisite resource=${contract.id} requires-runtime=${prerequisite}`,
        );
      }
      for (const configuration of contract.configuration) {
        lines.push(
          `${prefix} configuration ${configuration.id} readData=${configuration.readData} expectedResult=${configuration.expectedResult} writeData=${configuration.writeData} value=${configuration.value} remediation=write-action`,
        );
      }
    }
    lines.push(
      `${prefix} call-checks ${contract.checks.length}`,
      `${prefix} storage-checks ${contract.storageChecks.length}`,
    );
    for (const check of contract.checks) {
      lines.push(
        `manifest-call-check ${contract.id} ${check.id} simulation-caller=${check.caller} readData=${check.readData} expected=${check.expectedResult} remediation=none execution-authority=none`,
      );
    }
    for (const check of contract.storageChecks) {
      lines.push(
        `manifest-storage-check ${contract.id} ${check.id} slot=${check.slot} expected=${check.expectedWord} remediation=none execution-authority=none`,
      );
    }
    for (const check of contract.semanticChecks) {
      lines.push(
        `manifest-semantic-check ${contract.id} ${check.id} ${formatSemanticCheck(check)} remediation=none execution-authority=none`,
      );
    }
  }

  lines.push(`snapshots ${plan.snapshots.length}`);
  for (const snapshot of plan.snapshots) {
    lines.push(
      `snapshot ${snapshot.chainId} blockNumber=${snapshot.blockNumber} blockHash=${snapshot.blockHash}`,
    );
  }

  lines.push(`capabilities ${plan.capabilities.length}`);
  for (const capability of plan.capabilities) {
    const evidence =
      capability.status.kind === "available" || capability.status.kind === "bytecode-drift"
        ? ` observedRuntimeCodeHash=${capability.status.observedRuntimeCodeHash}`
        : capability.status.kind === "unreadable"
          ? ` reason=${capability.status.reason}`
          : "";
    lines.push(
      `capability ${capability.chainId} ${capability.kind} address=${capability.address} expectedRuntimeCodeHash=${capability.expectedRuntimeCodeHash} status=${capability.status.kind}${evidence}`,
    );
  }

  lines.push(`cells ${plan.cells.length}`);
  const resourcesById = new Map(
    plan.manifest.contracts.map((resource) => [resource.id, resource] as const),
  );
  for (const cell of plan.cells) {
    const resource = resourcesById.get(cell.resourceId);
    if (resource === undefined) throw new Error("reviewed plan cell has no manifest resource");
    const prefix = `cell ${cell.chainId} ${cell.resourceId}`;
    const deployment =
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
    const prerequisites =
      resource.kind === "managed"
        ? ` deployment=${deployment} requires-runtime=${resource.deployment.requiresRuntime.join(",") || "none"} strategy=${resource.deployment.kind}`
        : "";
    lines.push(
      `${prefix} address=${cell.address} expectedRuntimeCodeHash=${cell.expectedRuntimeCodeHash} status=${cell.status.kind}${formatCellStatus(cell.status)} kind=${resource.kind}${prerequisites}${resource.kind === "external" ? " mode=verify-only execution-authority=none" : ""}`,
    );
    lines.push(
      `${prefix} call-checks ${cell.checks.length}`,
      `${prefix} storage-checks ${cell.storageChecks.length}`,
    );
    for (const check of cell.storageChecks) {
      lines.push(
        `storage-check ${cell.chainId} ${cell.resourceId} ${check.id}${check.kind === "word" ? "" : ` kind=${check.kind}`} slot=${check.slot} expected=${check.expectedWord} remediation=none execution-authority=none`,
        formatStorageEvidence(cell, check),
      );
    }
    for (const check of cell.checks) {
      lines.push(
        `call-check ${cell.chainId} ${cell.resourceId} ${check.id}${check.kind === "call" ? "" : ` kind=${check.kind} target=${check.target}`} simulation-caller=${check.caller} readData=${check.readData} expected=${check.expectedResult} remediation=none execution-authority=none`,
        formatCallEvidence(cell, check),
      );
    }
    lines.push(`${prefix} configurations ${cell.configuration.length}`);
    for (const configuration of cell.configuration) {
      lines.push(
        `${prefix} configuration ${configuration.id} readData=${configuration.readData} caller=${configuration.caller} expectedResult=${configuration.expectedResult} remediation=write-action`,
        formatConfigurationEvidence(cell, configuration),
      );
    }
  }

  lines.push(`steps ${plan.steps.length}`);
  for (const [stepIndex, step] of plan.steps.entries()) {
    const prefix = `step ${step.chainId} ${step.id} index=${stepIndex}`;
    lines.push(
      `${prefix} resource=${step.resourceId} kind=${step.kind} configurationId=${step.configurationId ?? "none"} drift=${step.drift}`,
      `${prefix} call ${formatCall(step.call)}`,
      `${prefix} sender ${formatStepSender(step.sender)}`,
      `${prefix} enforcement ${formatEnforcement(step.enforcement)}`,
      `${prefix} postconditions ${step.postconditions.length}`,
    );
    step.postconditions.forEach((postcondition, index) => {
      lines.push(`${prefix} postcondition ${index} ${formatPostcondition(postcondition)}`);
    });
  }

  lines.push(`requirements ${plan.requirements.length}`);
  for (const requirement of plan.requirements) {
    const prefix = `requirement ${requirement.chainId}`;
    lines.push(
      `${prefix} sender ${formatPlanSender(requirement.sender)}`,
      `${prefix} enforcement ${formatEnforcement(requirement.enforcement)}`,
      `${prefix} calls ${requirement.calls.length}`,
    );
    requirement.calls.forEach((call, index) => {
      lines.push(`${prefix} call ${index} ${formatCall(call)}`);
    });
    lines.push(`${prefix} postconditions ${requirement.postconditions.length}`);
    requirement.postconditions.forEach((postcondition, index) => {
      lines.push(`${prefix} postcondition ${index} ${formatPostcondition(postcondition)}`);
    });
  }

  return `${lines.join("\n")}\n`;
}

function formatCellStatus(status: ReviewedPlan["cells"][number]["status"]): string {
  if (status.kind === "missing") return "";
  if (status.kind === "bytecode-drift") {
    return ` observedRuntimeCodeHash=${status.observedRuntimeCodeHash}`;
  }
  if (status.kind === "unreadable") {
    const runtime =
      "observedRuntimeCodeHash" in status
        ? ` observedRuntimeCodeHash=${status.observedRuntimeCodeHash}`
        : "";
    return `${runtime} source=${status.source} id=${status.id ?? "none"} reason=${status.reason}`;
  }
  if (status.kind === "drift") {
    return ` observedRuntimeCodeHash=${status.observedRuntimeCodeHash} configurationMismatches=${status.configurationMismatches.length} callMismatches=${status.callMismatches.length} storageMismatches=${status.storageMismatches.length}`;
  }
  return ` observedRuntimeCodeHash=${status.observedRuntimeCodeHash} configurationResults=${status.configurationResults.length} callResults=${status.callResults.length} storageResults=${status.storageResults.length}`;
}

function formatCallEvidence(
  cell: ReviewedPlan["cells"][number],
  check: ReviewedPlan["cells"][number]["checks"][number],
): string {
  const detail = `simulation-caller=${check.caller} readData=${check.readData} expected=${check.expectedResult}`;
  const boundary = "remediation=none execution-authority=none";
  const evidence = callCheckEvidence(cell, check.id);
  const label = evidence.kind === "drifted" ? "call-check-mismatch" : "call-check-observation";
  return `${label} ${cell.chainId} ${cell.resourceId} ${check.id} status=${evidence.kind} ${detail} observed=${evidence.observed}${formatEvidenceReason(evidence)} ${boundary}`;
}

function formatStorageEvidence(
  cell: ReviewedPlan["cells"][number],
  check: ReviewedPlan["cells"][number]["storageChecks"][number],
): string {
  const detail = `slot=${check.slot} expected=${check.expectedWord}`;
  const boundary = "remediation=none execution-authority=none";
  const evidence = storageCheckEvidence(cell, check.id);
  const label =
    evidence.kind === "drifted" ? "storage-check-mismatch" : "storage-check-observation";
  return `${label} ${cell.chainId} ${cell.resourceId} ${check.id} status=${evidence.kind} ${detail} observed=${evidence.observed}${formatEvidenceReason(evidence)} ${boundary}`;
}

function formatConfigurationEvidence(
  cell: ReviewedPlan["cells"][number],
  configuration: ReviewedPlan["cells"][number]["configuration"][number],
): string {
  const detail = `simulation-caller=${configuration.caller} readData=${configuration.readData} expected=${configuration.expectedResult}`;
  const evidence = configurationEvidence(cell, configuration.id);
  const label =
    evidence.kind === "drifted" ? "configuration-mismatch" : "configuration-observation";
  return `${label} ${cell.chainId} ${cell.resourceId} ${configuration.id} status=${evidence.kind} ${detail} observed=${evidence.observed}${formatEvidenceReason(evidence)} remediation=write-action`;
}

function formatEvidenceReason(
  evidence: ReturnType<
    typeof callCheckEvidence | typeof storageCheckEvidence | typeof configurationEvidence
  >,
): string {
  return evidence.kind === "unreadable" ? ` reason=${evidence.reason}` : "";
}

function formatManifestSender(sender: ManifestSender | undefined): string {
  if (sender === undefined) return "none";
  return sender.kind === "owner-eoa"
    ? `kind=${sender.kind} address=${sender.address}`
    : `kind=${sender.kind} accountId=${sender.accountId} address=${sender.address}`;
}

function formatManifestEnforcement(enforcement: ManifestEnforcement | undefined): string {
  return enforcement === undefined ? "none" : formatEnforcement(enforcement);
}

function formatStepSender(sender: StepSender | null): string {
  if (sender === null) return "kind=sender-independent";
  return sender.kind === "reviewed-owner-eoa"
    ? `kind=${sender.kind} address=${sender.address}`
    : `kind=${sender.kind} accountId=${sender.accountId} address=${sender.address}`;
}

function formatPlanSender(sender: PlanSender): string {
  if (sender.kind === "sender-independent") return `kind=${sender.kind}`;
  return sender.kind === "logical-smart-account"
    ? `kind=${sender.kind} accountId=${sender.accountId} address=${sender.address}`
    : `kind=${sender.kind} address=${sender.address}`;
}

function formatEnforcement(enforcement: PlanEnforcement | ManifestEnforcement): string {
  return `callScope=${enforcement.callScope} expiry=${enforcement.expiry} operationLimit=${enforcement.operationLimit}`;
}

function formatCall(call: DeploymentCall): string {
  return `target=${call.target} data=${call.data} value=${call.value}`;
}

function formatPostcondition(postcondition: DeploymentPostcondition): string {
  if (postcondition.kind === "runtime-code-hash") {
    return `kind=${postcondition.kind} address=${postcondition.address} expectedHash=${postcondition.expectedHash}`;
  }
  return `kind=${postcondition.kind} target=${postcondition.target} data=${postcondition.data} caller=${postcondition.caller} expectedResult=${postcondition.expectedResult}`;
}
