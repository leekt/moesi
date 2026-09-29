import type { MoesiVerificationResult, ReviewedPlan } from "moesi";
import { formatObservationCause } from "./observation-output.js";

export function renderVerificationJson(result: MoesiVerificationResult): string {
  return `${JSON.stringify(result)}\n`;
}

export function renderVerificationHuman(
  result: MoesiVerificationResult,
  plan: ReviewedPlan,
): string {
  const resourceKinds = new Map(
    plan.manifest.contracts.map((resource) => [resource.id, resource.kind] as const),
  );
  const reviewedCells = new Map(
    plan.cells.map((cell) => [`${cell.chainId}:${cell.resourceId}`, cell] as const),
  );
  const lines = [
    `Moesi verification ${result.planId}`,
    `status ${result.status}`,
    result.status === "converged"
      ? "Fresh chain observation confirms that all reviewed resources match the manifest."
      : result.status === "drifted"
        ? "Fresh chain observation found drift. Review the evidence and create a new plan before executing changes."
        : "Verification could not read all required evidence. Check the RPC and retry; unreadable state does not prove drift.",
    `manifest ${result.manifestHash}`,
    `chains ${result.chains.length}`,
  ];
  for (const chain of result.chains) {
    const snapshot =
      chain.snapshot === null
        ? "unavailable"
        : `${chain.snapshot.blockNumber}:${chain.snapshot.blockHash}`;
    lines.push(`${chain.chainId} chain ${chain.status} snapshot=${snapshot}`);
    for (const cell of chain.cells) {
      const resourceKind = resourceKinds.get(cell.resourceId);
      if (resourceKind === undefined) throw new Error("verification cell has no manifest resource");
      const resourceMode =
        resourceKind === "external" ? " mode=verify-only execution-authority=none" : "";
      if (cell.status.kind === "unreadable") {
        if (cell.status.peer)
          lines.push(
            `peer ${cell.status.peer.chainId} ${cell.status.peer.address} status=${cell.status.peer.status.kind} expected=${cell.status.peer.expectedRuntimeCodeHash} reason=${cell.status.reason}`,
          );
        if (cell.status.cause)
          lines.push(
            `observation ${chain.chainId} ${cell.resourceId}${formatObservationCause(cell.status.cause)}`,
          );
        const runtimeSatisfied =
          cell.status.reason === "configuration-read-failed" ||
          cell.status.reason === "configuration-invalid-response" ||
          cell.status.reason === "storage-unavailable" ||
          cell.status.reason === "storage-read-failed" ||
          cell.status.reason === "storage-invalid-response" ||
          cell.status.reason === "call-read-failed" ||
          cell.status.reason === "call-invalid-response";
        lines.push(
          `${chain.chainId} ${cell.resourceId} runtime ${runtimeSatisfied ? "satisfied" : "unreadable"} address=${cell.address} expected=${cell.expectedRuntimeCodeHash}${runtimeSatisfied ? "" : ` reason=${cell.status.reason}`} kind=${resourceKind}${resourceMode}`,
        );
      } else {
        const runtimeStatus =
          cell.status.observedRuntimeCodeHash === cell.expectedRuntimeCodeHash
            ? "satisfied"
            : "drifted";
        lines.push(
          `${chain.chainId} ${cell.resourceId} runtime ${runtimeStatus} address=${cell.address} expected=${cell.expectedRuntimeCodeHash} observed=${cell.status.observedRuntimeCodeHash} kind=${resourceKind}${resourceMode}`,
        );
      }
      for (const storage of cell.storageChecks) {
        const reviewedCheck = reviewedCells
          .get(`${chain.chainId}:${cell.resourceId}`)
          ?.storageChecks.find(({ id }) => id === storage.id);
        if (reviewedCheck === undefined) {
          throw new Error("external verification storage check is not reviewed by the plan");
        }
        const storageDetail =
          storage.status.kind === "unreadable"
            ? `observed=unavailable reason=${storage.status.reason}`
            : `observed=${storage.status.observedWord}`;
        lines.push(
          `${chain.chainId} ${cell.resourceId} storage-check ${storage.id}${storage.kind === "word" ? "" : ` kind=${storage.kind}`} ${storage.status.kind} slot=${reviewedCheck.slot} expected=${storage.expectedWord} ${storageDetail} remediation=none execution-authority=none`,
        );
      }
      for (const check of cell.callChecks) {
        const reviewedCheck = reviewedCells
          .get(`${chain.chainId}:${cell.resourceId}`)
          ?.checks.find(({ id }) => id === check.id);
        if (reviewedCheck === undefined) {
          throw new Error("verification call check is not reviewed by the plan");
        }
        const callDetail =
          check.status.kind === "unreadable"
            ? `observed=unavailable reason=${check.status.reason}`
            : `observed=${check.status.observedResult}`;
        lines.push(
          `${chain.chainId} ${cell.resourceId} call-check ${check.id}${check.kind === "call" ? "" : ` kind=${check.kind} target=${check.target}`} ${check.status.kind} simulation-caller=${reviewedCheck.caller} readData=${reviewedCheck.readData} expected=${check.expectedResult} ${callDetail} remediation=none execution-authority=none`,
        );
      }
      for (const configuration of cell.configurations) {
        if (resourceKind === "external") {
          throw new Error("external verification unexpectedly contains repairable configuration");
        }
        const reviewedConfiguration = reviewedCells
          .get(`${chain.chainId}:${cell.resourceId}`)
          ?.configuration.find(({ id }) => id === configuration.id);
        if (reviewedConfiguration === undefined) {
          throw new Error("verification configuration is not reviewed by the plan");
        }
        const configurationDetail =
          configuration.status.kind === "unreadable"
            ? `observed=unavailable reason=${configuration.status.reason}`
            : `observed=${configuration.status.observedResult}`;
        lines.push(
          `${chain.chainId} ${cell.resourceId} configuration ${configuration.id} ${configuration.status.kind} simulation-caller=${reviewedConfiguration.caller} readData=${reviewedConfiguration.readData} expected=${configuration.expectedResult} ${configurationDetail} remediation=write-action`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function verificationExitCode(result: MoesiVerificationResult): 0 | 2 | 3 {
  if (result.status === "converged") return 0;
  return result.status === "drifted" ? 2 : 3;
}
