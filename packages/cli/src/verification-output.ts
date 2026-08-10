import type { MoesiVerificationResult, ReviewedPlan } from "moesi";

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
        const runtimeSatisfied =
          cell.status.reason === "configuration-read-failed" ||
          cell.status.reason === "configuration-invalid-response" ||
          cell.status.reason === "storage-unavailable" ||
          cell.status.reason === "storage-read-failed" ||
          cell.status.reason === "storage-invalid-response";
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
        if (resourceKind !== "external") {
          throw new Error("managed verification unexpectedly contains an external storage check");
        }
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
          `${chain.chainId} ${cell.resourceId} external-storage-check ${storage.id} ${storage.status.kind} slot=${reviewedCheck.slot} expected=${storage.expectedWord} ${storageDetail} remediation=none execution-authority=none`,
        );
      }
      for (const configuration of cell.configurations) {
        if (resourceKind === "external") {
          const reviewedCheck = reviewedCells
            .get(`${chain.chainId}:${cell.resourceId}`)
            ?.configuration.find(({ id }) => id === configuration.id);
          if (reviewedCheck === undefined) {
            throw new Error("external verification check is not reviewed by the plan");
          }
          const externalDetail =
            configuration.status.kind === "unreadable"
              ? `observed=unavailable reason=${configuration.status.reason}`
              : `observed=${configuration.status.observedResult}`;
          lines.push(
            `${chain.chainId} ${cell.resourceId} external-check ${configuration.id} ${configuration.status.kind} simulation-caller=${reviewedCheck.caller} readData=${reviewedCheck.readData} expected=${configuration.expectedResult} ${externalDetail} remediation=none execution-authority=none`,
          );
          continue;
        }
        const configurationDetail =
          configuration.status.kind === "unreadable"
            ? `reason=${configuration.status.reason}`
            : `observed=${configuration.status.observedResult}`;
        lines.push(
          `${chain.chainId} ${cell.resourceId} configuration ${configuration.id} ${configuration.status.kind} expected=${configuration.expectedResult} ${configurationDetail}`,
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
