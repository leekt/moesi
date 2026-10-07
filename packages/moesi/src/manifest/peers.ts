import type { Address, Hex } from "cetane";
import { keccak256 } from "cetane/utils";
import { MoesiManifestError } from "../errors.js";
import { compareAscii, snapshotArray } from "../internal.js";
import type { ConfigurationPeer, ResolvedMoesiManifest } from "./types.js";

export function peerKey(peer: ConfigurationPeer): string {
  return `${peer.chainId}:${peer.address}`;
}

export function parseConfigurationPeers(input: unknown, path: string): ConfigurationPeer[] {
  const entries = snapshotArray(input);
  if (!entries || entries.length > 32)
    throw new MoesiManifestError("invalid_resource", path, "configuration peers are invalid");
  const seen = new Set<string>();
  return entries
    .map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new MoesiManifestError("invalid_resource", path, "configuration peer is invalid");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Object.keys(descriptors).length !== 3 ||
        ["chainId", "address", "expectedRuntimeCodeHash"].some(
          (key) => !descriptors[key] || !("value" in descriptors[key]!),
        )
      )
        throw new MoesiManifestError(
          "invalid_resource",
          path,
          "configuration peer fields are invalid",
        );
      const chainId = descriptors.chainId!.value as unknown;
      const address = descriptors.address!.value as unknown;
      const hash = descriptors.expectedRuntimeCodeHash!.value as unknown;
      if (
        typeof chainId !== "number" ||
        !Number.isSafeInteger(chainId) ||
        chainId <= 0 ||
        typeof address !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(address) ||
        /^0x0{40}$/.test(address) ||
        typeof hash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
        hash.toLowerCase() === keccak256("0x")
      )
        throw new MoesiManifestError(
          "invalid_resource",
          path,
          "configuration peer identity is invalid",
        );
      const peer = {
        chainId,
        address: address.toLowerCase() as Address,
        expectedRuntimeCodeHash: hash.toLowerCase() as Hex,
      };
      if (seen.has(peerKey(peer)))
        throw new MoesiManifestError("invalid_resource", path, "configuration peer is duplicated");
      seen.add(peerKey(peer));
      return peer;
    })
    .sort((a, b) => a.chainId - b.chainId || compareAscii(a.address, b.address));
}

export function requiredConfigurationPeers(manifest: ResolvedMoesiManifest): ConfigurationPeer[] {
  const peers = new Map<string, ConfigurationPeer>();
  for (const resource of manifest.contracts) {
    if (resource.kind !== "managed") continue;
    for (const rule of resource.configuration)
      for (const peer of rule.after ?? []) {
        const previous = peers.get(peerKey(peer));
        if (previous && previous.expectedRuntimeCodeHash !== peer.expectedRuntimeCodeHash)
          throw new MoesiManifestError(
            "invalid_resource",
            "manifest",
            "peer runtime requirements contradict one another",
          );
        peers.set(peerKey(peer), peer);
      }
  }
  if (peers.size > 1024)
    throw new MoesiManifestError("invalid_resource", "manifest", "too many configuration peers");
  return [...peers.values()].sort(
    (a, b) => a.chainId - b.chainId || compareAscii(a.address, b.address),
  );
}
