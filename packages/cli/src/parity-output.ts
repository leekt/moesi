import type {
  FleetParityObservedCell,
  FleetParityReadObservation,
  FleetParityResult,
} from "moesi/fleet";
import { formatObservationCause } from "./observation-output.js";

function observed(value: FleetParityReadObservation | undefined): string {
  return !value
    ? "absent"
    : value.kind === "readable"
      ? value.value
      : value.kind === "not-deployed"
        ? "not-deployed"
        : `unreadable:${value.reason}${formatObservationCause(value.cause)}`;
}
function rows(cell: FleetParityObservedCell | null, kind: "configuration" | "call" | "storage") {
  return !cell
    ? []
    : kind === "configuration"
      ? cell.configuration
      : kind === "call"
        ? cell.checks
        : cell.storageChecks;
}
export function renderParityHuman(result: FleetParityResult): string {
  const lines = [
    `Moesi fleet parity ${result.status}`,
    `baseline ${result.baselineHash}`,
    `manifest ${result.manifestHash}`,
    "comparison addresses, declared reads and pinned live values; execution not-started",
  ];
  for (const chain of result.chains) {
    lines.push(
      `chain ${chain.chainId} snapshot=${chain.snapshot ? `${chain.snapshot.blockNumber}:${chain.snapshot.blockHash}` : "unavailable"} plan=${chain.candidatePlan?.disposition ?? "unavailable"}`,
    );
    if (chain.error)
      lines.push(
        `observation ${chain.chainId} ${chain.error.code}${formatObservationCause(chain.error.cause)}`,
      );
    for (const cell of chain.cells) {
      lines.push(
        `${chain.chainId} ${cell.resourceId} baseline=${cell.baseline?.address ?? "absent"} candidate=${cell.candidate?.address ?? "absent"} baseline-state=${cell.baseline?.liveState ?? "absent"} candidate-state=${cell.candidate?.liveState ?? "absent"} differences=${cell.differences.length}`,
      );
      for (const difference of cell.differences) {
        const prefix = `difference ${chain.chainId} ${cell.resourceId} ${difference.code}`;
        if (!difference.readKind) {
          lines.push(prefix);
          continue;
        }
        const previous = rows(cell.baseline, difference.readKind).find(
          ({ id }) => id === difference.baselineId,
        );
        const next = rows(cell.candidate, difference.readKind).find(
          ({ id }) => id === difference.candidateId,
        );
        const expected = (row: typeof previous) =>
          !row ? "absent" : "expectedWord" in row ? row.expectedWord : row.expectedResult;
        lines.push(
          `${prefix} kind=${difference.readKind} baseline-id=${previous?.id ?? "absent"} candidate-id=${next?.id ?? "absent"} baseline-expected=${expected(previous)} candidate-expected=${expected(next)} baseline-observed=${observed(previous?.observation)} candidate-observed=${observed(next?.observation)}`,
        );
      }
      for (const [side, value] of [
        ["baseline", cell.baseline],
        ["candidate", cell.candidate],
      ] as const) {
        if (!value) continue;
        if (value.runtime.kind === "unreadable")
          lines.push(
            `runtime ${chain.chainId} ${cell.resourceId} ${side} unreadable:${value.runtime.reason}${formatObservationCause(value.runtime.cause)}`,
          );
        else if (
          value.runtime.kind === "deployed" &&
          value.runtime.runtimeCodeHash !== value.expectedRuntimeCodeHash
        )
          lines.push(
            `runtime ${chain.chainId} ${cell.resourceId} ${side} expected=${value.expectedRuntimeCodeHash} observed=${value.runtime.runtimeCodeHash}`,
          );
        for (const kind of ["configuration", "call", "storage"] as const)
          for (const row of rows(value, kind)) {
            const expected = "expectedWord" in row ? row.expectedWord : row.expectedResult;
            if (
              row.observation.kind !== "readable" ||
              row.observation.value !== expected ||
              ("readiness" in row && row.readiness !== "ready")
            )
              lines.push(
                `read ${chain.chainId} ${cell.resourceId} ${side} ${kind} ${row.id} expected=${expected} observed=${observed(row.observation)}${"readiness" in row ? ` readiness=${row.readiness}` : ""}`,
              );
          }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
