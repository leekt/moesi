import type { MoesiManifest, MoesiObservationAdapter } from "moesi";
import {
  type FleetObservationRecord,
  type FleetObservationStore,
  loadFleetObservation,
  observeFleetChain,
  parseFleetObservationRecord,
} from "moesi/fleet";
import { SqliteFleetObservationStore } from "moesi/node";
import { keccak256, stringToHex } from "viem";

export { loadFleetObservation, parseFleetObservationRecord, SqliteFleetObservationStore };
export const key = { scope: "packed", chainId: 1 };
const manifest: MoesiManifest = {
  version: "moesi.manifest/v6",
  contracts: [
    {
      kind: "external",
      id: "sample",
      address: `0x${"aa".repeat(20)}`,
      expectedRuntimeCodeHash: keccak256("0x6000"),
      checks: [],
      storageChecks: [],
    },
  ],
};
export function scan(store: FleetObservationStore, reading: () => Promise<void> = async () => {}) {
  const observer: MoesiObservationAdapter = {
    async captureSnapshot() {
      return { blockNumber: "42", blockHash: `0x${"bb".repeat(32)}` };
    },
    async readCode() {
      await reading();
      return "0x6000";
    },
    async readCall() {
      return "0x";
    },
    async checkBlockAncestry() {
      return true;
    },
  };
  return observeFleetChain({
    ...key,
    store,
    observer,
    definitionHash: keccak256(stringToHex(JSON.stringify(manifest))),
    prepare: async () => ({ manifest, reads: [] }),
  });
}
export function nextAttempt(record: FleetObservationRecord): FleetObservationRecord {
  return parseFleetObservationRecord({
    ...record,
    revision: record.revision + 1,
    state: "pending",
    manifestHash: null,
    startedAt: Date.now(),
    completedAt: null,
    failure: null,
  });
}
