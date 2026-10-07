import { keccak256 } from "cetane/utils";
import { MoesiPlanError } from "../errors.js";
import { asRecord, exactKeys, hashCanonical, snapshotArray } from "../internal.js";
import { parseConfigurationPeers, peerKey, requiredConfigurationPeers } from "../manifest/peers.js";
import type { ResolvedMoesiManifest } from "../manifest/types.js";
import { parseObservationCause } from "../observation/failure.js";
import type { ConfigurationPeerObservation } from "../observation/peers.js";

export function parsePeerObservations(
  value: unknown,
  manifest: ResolvedMoesiManifest,
): ConfigurationPeerObservation[] {
  const fail = (): never => {
    throw new MoesiPlanError(
      "invalid_peer",
      "plan.peers",
      "configuration peer evidence is invalid",
    );
  };
  try {
    const entries = snapshotArray(value);
    const required = requiredConfigurationPeers(manifest);
    if (!entries || entries.length !== required.length) return fail();
    const seen = new Set<string>();
    const pins = new Map<number, string>();
    const results = entries.map((entry): ConfigurationPeerObservation => {
      const record = asRecord(entry, "plan.peers", "invalid_peer");
      exactKeys(
        record,
        ["chainId", "address", "expectedRuntimeCodeHash", "snapshot", "status"],
        "plan.peers",
      );
      const peer = parseConfigurationPeers(
        [
          {
            chainId: record.chainId,
            address: record.address,
            expectedRuntimeCodeHash: record.expectedRuntimeCodeHash,
          },
        ],
        "plan.peers",
      )[0]!;
      if (
        seen.has(peerKey(peer)) ||
        !required.some((item) => hashCanonical(item) === hashCanonical(peer))
      )
        return fail();
      seen.add(peerKey(peer));
      let snapshot = null;
      if (record.snapshot !== null) {
        const source = asRecord(record.snapshot, "plan.peers.snapshot", "invalid_peer");
        exactKeys(source, ["chainId", "blockNumber", "blockHash"], "plan.peers.snapshot");
        if (
          source.chainId !== peer.chainId ||
          typeof source.blockNumber !== "string" ||
          !/^(?:0|[1-9][0-9]{0,77})$/.test(source.blockNumber) ||
          BigInt(source.blockNumber) >= 1n << 256n ||
          typeof source.blockHash !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(source.blockHash)
        )
          return fail();
        snapshot = {
          chainId: peer.chainId,
          blockNumber: source.blockNumber,
          blockHash: source.blockHash.toLowerCase() as `0x${string}`,
        };
        const previous = pins.get(peer.chainId);
        const identity = hashCanonical(snapshot);
        if (previous !== undefined && previous !== identity) return fail();
        pins.set(peer.chainId, identity);
      }
      const status = asRecord(record.status, "plan.peers.status", "invalid_peer");
      if (status.kind === "unreadable") {
        exactKeys(status, ["kind", "reason", "cause"], "plan.peers.status");
        if (
          !["snapshot-unreadable", "read-failed", "invalid-response"].includes(
            String(status.reason),
          ) ||
          (snapshot === null) !== (status.reason === "snapshot-unreadable")
        )
          return fail();
        return {
          ...peer,
          snapshot,
          status: {
            kind: "unreadable",
            reason: status.reason as "snapshot-unreadable" | "read-failed" | "invalid-response",
            ...(Object.hasOwn(status, "cause")
              ? { cause: parseObservationCause(status.cause) }
              : {}),
          },
        };
      }
      if (!snapshot) return fail();
      if (status.kind === "missing") {
        exactKeys(status, ["kind"], "plan.peers.status");
        return { ...peer, snapshot, status: { kind: "missing" } };
      }
      exactKeys(status, ["kind", "observedRuntimeCodeHash"], "plan.peers.status");
      if (
        (status.kind !== "available" && status.kind !== "bytecode-drift") ||
        typeof status.observedRuntimeCodeHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(status.observedRuntimeCodeHash)
      )
        return fail();
      const observedRuntimeCodeHash = status.observedRuntimeCodeHash.toLowerCase() as `0x${string}`;
      if (
        observedRuntimeCodeHash === keccak256("0x") ||
        (observedRuntimeCodeHash === peer.expectedRuntimeCodeHash) !== (status.kind === "available")
      )
        return fail();
      return { ...peer, snapshot, status: { kind: status.kind, observedRuntimeCodeHash } };
    });
    return required.map((peer) => results.find((item) => peerKey(item) === peerKey(peer))!);
  } catch {
    return fail();
  }
}
