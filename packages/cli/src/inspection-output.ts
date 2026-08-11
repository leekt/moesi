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

export function renderInspectionJson(plan: ReviewedPlan): string {
  return `${JSON.stringify({ version: "moesi.cli-plan/v1", plan })}\n`;
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
      continue;
    }
    lines.push(
      `${prefix} kind=managed`,
      `${prefix} deployment kind=${contract.deployment.kind} salt=${contract.deployment.salt} initCode=${contract.deployment.initCode} value=${contract.deployment.value}`,
      `${prefix} sender ${formatManifestSender(contract.sender)}`,
      `${prefix} enforcement ${formatManifestEnforcement(contract.enforcement)}`,
      `${prefix} configurations ${contract.configuration.length}`,
    );
    for (const configuration of contract.configuration) {
      lines.push(
        `${prefix} configuration ${configuration.id} readData=${configuration.readData} expectedResult=${configuration.expectedResult} writeData=${configuration.writeData} value=${configuration.value}`,
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
    lines.push(
      `${prefix} address=${cell.address} expectedRuntimeCodeHash=${cell.expectedRuntimeCodeHash} status=${cell.status.kind}${formatCellStatus(cell.status)} kind=${resource.kind}${resource.kind === "external" ? " mode=verify-only execution-authority=none" : ""}`,
      `${prefix} configurations ${cell.configuration.length}`,
    );
    for (const configuration of cell.configuration) {
      lines.push(
        `${prefix} configuration ${configuration.id} readData=${configuration.readData} caller=${configuration.caller} expectedResult=${configuration.expectedResult}${formatConfigurationEvidence(cell.status, configuration.id)}`,
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
    return ` reason=${status.reason} configurationId=${status.configurationId ?? "none"}`;
  }
  if (status.kind === "configuration-drift") {
    return ` observedRuntimeCodeHash=${status.observedRuntimeCodeHash} mismatches=${status.mismatches.length}`;
  }
  return ` observedRuntimeCodeHash=${status.observedRuntimeCodeHash} configurationResults=${status.configurationResults.length}`;
}

function formatConfigurationEvidence(
  status: ReviewedPlan["cells"][number]["status"],
  configurationId: string,
): string {
  if (status.kind === "converged") {
    const evidence = status.configurationResults.find(({ id }) => id === configurationId);
    return evidence === undefined
      ? " evidence=not-observed"
      : ` evidence=result result=${evidence.result}`;
  }
  if (status.kind === "configuration-drift") {
    const evidence = status.mismatches.find(({ id }) => id === configurationId);
    return evidence === undefined
      ? " evidence=satisfied"
      : ` evidence=mismatch observedResult=${evidence.observedResult}`;
  }
  if (status.kind === "unreadable" && status.configurationId === configurationId) {
    return ` evidence=unreadable reason=${status.reason}`;
  }
  if (status.kind === "unreadable" && status.configurationId !== null) {
    return " evidence=not-recorded";
  }
  return " evidence=not-observed";
}

function formatManifestSender(sender: ManifestSender | undefined): string {
  if (sender === undefined) return "none";
  return sender.kind === "owner-eoa"
    ? `kind=${sender.kind} address=${sender.address}`
    : `kind=${sender.kind} accountId=${sender.accountId}`;
}

function formatManifestEnforcement(enforcement: ManifestEnforcement | undefined): string {
  return enforcement === undefined ? "none" : formatEnforcement(enforcement);
}

function formatStepSender(sender: StepSender | null): string {
  if (sender === null) return "kind=sender-independent";
  return sender.kind === "reviewed-owner-eoa"
    ? `kind=${sender.kind} address=${sender.address}`
    : `kind=${sender.kind} accountId=${sender.accountId}`;
}

function formatPlanSender(sender: PlanSender): string {
  if (sender.kind === "sender-independent") return `kind=${sender.kind}`;
  return sender.kind === "logical-smart-account"
    ? `kind=${sender.kind} accountId=${sender.accountId}`
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
