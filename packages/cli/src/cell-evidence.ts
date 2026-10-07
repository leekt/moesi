import type { Hex } from "cetane";
import type { ResourceCell } from "moesi";

export type CellEvidence =
  | Readonly<{ kind: "satisfied" | "drifted"; observed: Hex }>
  | Readonly<{
      kind: "unreadable";
      observed: "unavailable";
      reason: "unavailable" | "read-failed" | "invalid-response";
    }>
  | Readonly<{
      kind: "not-recorded" | "not-observed";
      observed: "not-recorded" | "not-observed";
    }>;

type EvidenceCell = Readonly<{
  checks: ResourceCell["checks"];
  storageChecks: ResourceCell["storageChecks"];
  configuration: ResourceCell["configuration"];
  status: ResourceCell["status"];
}>;

export function callCheckEvidence(cell: EvidenceCell, checkId: string): CellEvidence {
  const check = cell.checks.find(({ id }) => id === checkId);
  if (check === undefined) throw new Error("reviewed cell has no call check");
  if (cell.status.kind === "converged") {
    const result = cell.status.callResults.find(({ id }) => id === checkId);
    return result === undefined
      ? { kind: "not-observed", observed: "not-observed" }
      : { kind: "satisfied", observed: result.result };
  }
  if (cell.status.kind === "drift") {
    const mismatch = cell.status.callMismatches.find(({ id }) => id === checkId);
    return mismatch === undefined
      ? { kind: "satisfied", observed: check.expectedResult }
      : { kind: "drifted", observed: mismatch.observedResult };
  }
  return sequentialEvidence(cell, "call-check", checkId);
}

export function storageCheckEvidence(cell: EvidenceCell, checkId: string): CellEvidence {
  const check = cell.storageChecks.find(({ id }) => id === checkId);
  if (check === undefined) throw new Error("reviewed cell has no storage check");
  if (cell.status.kind === "converged") {
    const result = cell.status.storageResults.find(({ id }) => id === checkId);
    return result === undefined
      ? { kind: "not-observed", observed: "not-observed" }
      : { kind: "satisfied", observed: result.word };
  }
  if (cell.status.kind === "drift") {
    const mismatch = cell.status.storageMismatches.find(({ id }) => id === checkId);
    return mismatch === undefined
      ? { kind: "satisfied", observed: check.expectedWord }
      : { kind: "drifted", observed: mismatch.observedWord };
  }
  return sequentialEvidence(cell, "storage-check", checkId);
}

export function configurationEvidence(cell: EvidenceCell, configurationId: string): CellEvidence {
  const configuration = cell.configuration.find(({ id }) => id === configurationId);
  if (configuration === undefined) throw new Error("reviewed cell has no configuration");
  if (cell.status.kind === "converged") {
    const result = cell.status.configurationResults.find(({ id }) => id === configurationId);
    return result === undefined
      ? { kind: "not-observed", observed: "not-observed" }
      : { kind: "satisfied", observed: result.result };
  }
  if (cell.status.kind === "drift") {
    const mismatch = cell.status.configurationMismatches.find(({ id }) => id === configurationId);
    return mismatch === undefined
      ? { kind: "satisfied", observed: configuration.expectedResult }
      : { kind: "drifted", observed: mismatch.observedResult };
  }
  return sequentialEvidence(cell, "configuration", configurationId);
}

function sequentialEvidence(
  cell: EvidenceCell,
  source: "storage-check" | "call-check" | "configuration",
  id: string,
): CellEvidence {
  if (cell.status.kind !== "unreadable" || cell.status.source === "runtime-code") {
    return { kind: "not-observed", observed: "not-observed" };
  }
  const sourceOrder = stageOrder(source);
  const failureOrder = stageOrder(cell.status.source);
  if (sourceOrder < failureOrder) {
    return { kind: "not-recorded", observed: "not-recorded" };
  }
  if (sourceOrder > failureOrder) {
    return { kind: "not-observed", observed: "not-observed" };
  }
  if (id === cell.status.id) {
    return { kind: "unreadable", observed: "unavailable", reason: cell.status.reason };
  }
  const ids =
    source === "storage-check"
      ? cell.storageChecks.map(({ id: checkId }) => checkId)
      : source === "call-check"
        ? cell.checks.map(({ id: checkId }) => checkId)
        : cell.configuration.map(({ id: configurationId }) => configurationId);
  const index = ids.indexOf(id);
  const failureIndex = ids.indexOf(cell.status.id);
  return index >= 0 && failureIndex >= 0 && index < failureIndex
    ? { kind: "not-recorded", observed: "not-recorded" }
    : { kind: "not-observed", observed: "not-observed" };
}

function stageOrder(source: "storage-check" | "call-check" | "configuration"): number {
  if (source === "storage-check") return 0;
  return source === "call-check" ? 1 : 2;
}
