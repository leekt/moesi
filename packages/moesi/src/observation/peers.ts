import { keccak256 } from "cetane/utils";
import type { ConfigurationPeer } from "../manifest/types.js";
import { type ObservationCause, observationCause, throwIfObservationAborted } from "./failure.js";
import { captureChainSnapshot, observeRuntimeCode } from "./observe.js";
import { readConcurrently } from "./parallel.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "./types.js";

export interface ConfigurationPeerObservation extends ConfigurationPeer {
  readonly snapshot: ChainSnapshot | null;
  readonly status:
    | { readonly kind: "available"; readonly observedRuntimeCodeHash: `0x${string}` }
    | { readonly kind: "missing" }
    | { readonly kind: "bytecode-drift"; readonly observedRuntimeCodeHash: `0x${string}` }
    | {
        readonly kind: "unreadable";
        readonly reason: "snapshot-unreadable" | "read-failed" | "invalid-response";
        readonly cause?: ObservationCause;
      };
}

export async function observeConfigurationPeers(
  observer: MoesiObservationAdapter,
  peers: readonly ConfigurationPeer[],
): Promise<ConfigurationPeerObservation[]> {
  const pins = new Map<number, Promise<ChainSnapshot>>();
  return readConcurrently(peers, async (peer) => {
    let snapshot: ChainSnapshot;
    try {
      let pin = pins.get(peer.chainId);
      if (!pin) {
        pin = captureChainSnapshot(observer, peer.chainId);
        pins.set(peer.chainId, pin);
      }
      snapshot = await pin;
    } catch (error) {
      throwIfObservationAborted(error);
      const cause = observationCause(error);
      return {
        ...peer,
        snapshot: null,
        status: { kind: "unreadable", reason: "snapshot-unreadable", ...(cause ? { cause } : {}) },
      };
    }
    const code = await observeRuntimeCode(observer, {
      chainId: peer.chainId,
      address: peer.address,
      snapshot,
    });
    if (code.kind === "unreadable") return { ...peer, snapshot, status: code };
    if (code.code === "0x") return { ...peer, snapshot, status: { kind: "missing" } };
    const observedRuntimeCodeHash = keccak256(code.code);
    return {
      ...peer,
      snapshot,
      status: {
        kind:
          observedRuntimeCodeHash === peer.expectedRuntimeCodeHash ? "available" : "bytecode-drift",
        observedRuntimeCodeHash,
      },
    };
  });
}

export type ConfigurationReadiness = "ready" | "pending-peer" | "blocked-peer";

/** A fresh peer observation must not replace a reviewed pin with an older or unrelated fork. */
export async function peerSnapshotDescends(
  observer: MoesiObservationAdapter,
  peer: ConfigurationPeerObservation,
  anchor: ChainSnapshot,
): Promise<boolean> {
  if (!peer.snapshot || BigInt(peer.snapshot.blockNumber) < BigInt(anchor.blockNumber))
    return false;
  try {
    return (
      (await observer.checkBlockAncestry({
        chainId: peer.chainId,
        ancestor: anchor,
        descendant: peer.snapshot,
      })) === true
    );
  } catch (error) {
    throwIfObservationAborted(error);
    return false;
  }
}

export function configurationReadiness(
  peers: readonly ConfigurationPeer[],
  observations: readonly ConfigurationPeerObservation[],
): ConfigurationReadiness {
  let readiness: ConfigurationReadiness = "ready";
  for (const peer of peers) {
    const observation = observations.find(
      (candidate) =>
        candidate.chainId === peer.chainId &&
        candidate.address === peer.address &&
        candidate.expectedRuntimeCodeHash === peer.expectedRuntimeCodeHash,
    );
    if (
      !observation ||
      observation.status.kind === "unreadable" ||
      observation.status.kind === "bytecode-drift"
    )
      return "blocked-peer";
    if (observation.status.kind === "missing") readiness = "pending-peer";
  }
  return readiness;
}
