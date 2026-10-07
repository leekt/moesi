import type { AccountModulesObservation } from "moesi";

/** Event counts describe history; only entries describe installed authority. */
export function moduleEvidenceLines(
  prefix: string,
  evidence?: AccountModulesObservation,
): string[] {
  if (!evidence) return [];
  if (evidence.kind === "unreadable")
    return [`${prefix} account-modules unreadable reason=${evidence.reason}`];
  const { inventory } = evidence;
  return [
    `${prefix} account-modules ${evidence.kind} profile=${inventory.profile} state-confirmed=${inventory.entries.length} complete=${inventory.complete} reason=${inventory.reason ?? "none"}`,
    `${prefix} module-history from=${inventory.history.fromBlock} to=${inventory.history.toBlock} next=${inventory.history.nextBlock} complete=${inventory.history.complete}`,
    ...inventory.history.counts.map(
      (row) =>
        `${prefix} module-events type=${row.type} address=${row.address} installed=${row.installed} uninstalled=${row.uninstalled}`,
    ),
    ...inventory.entries.map((entry) => `${prefix} module-state ${JSON.stringify(entry)}`),
    ...evidence.differences.map((item) => `${prefix} module-drift ${item.kind} ${item.key}`),
  ];
}
