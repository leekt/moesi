import type { MoesiVerificationResult } from "moesi";

export function renderVerificationJson(result: MoesiVerificationResult): string {
  return `${JSON.stringify(result)}\n`;
}

export function renderVerificationHuman(result: MoesiVerificationResult): string {
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
      if (cell.status.kind === "unreadable") {
        const runtimeSatisfied =
          cell.status.reason === "configuration-read-failed" ||
          cell.status.reason === "configuration-invalid-response";
        lines.push(
          `${chain.chainId} ${cell.resourceId} runtime ${runtimeSatisfied ? "satisfied" : "unreadable"} address=${cell.address} expected=${cell.expectedRuntimeCodeHash}${runtimeSatisfied ? "" : ` reason=${cell.status.reason}`}`,
        );
      } else {
        const runtimeStatus =
          cell.status.observedRuntimeCodeHash === cell.expectedRuntimeCodeHash
            ? "satisfied"
            : "drifted";
        lines.push(
          `${chain.chainId} ${cell.resourceId} runtime ${runtimeStatus} address=${cell.address} expected=${cell.expectedRuntimeCodeHash} observed=${cell.status.observedRuntimeCodeHash}`,
        );
      }
      for (const configuration of cell.configurations) {
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
