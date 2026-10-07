import { keccak256 } from "cetane/utils";
import { deepFreeze } from "../internal.js";
import { captureChainSnapshot, observeRuntimeCode } from "../observation/observe.js";
import { observeOwner, observeRole } from "../observation/ownership.js";
import { observeERC1967 } from "../observation/proxy.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "../observation/types.js";
import { parseDiscoveryRequest } from "./input.js";
import {
  type ChainDiscovery,
  type DiscoveryResourceRequest,
  MOESI_DISCOVERY_VERSION,
  type MoesiDiscoverRequest,
  type MoesiDiscoveryResult,
  type ResourceDiscovery,
  type RoleDiscovery,
} from "./types.js";

export async function discover(
  input: MoesiDiscoverRequest,
  source: MoesiObservationAdapter,
): Promise<MoesiDiscoveryResult> {
  const request = parseDiscoveryRequest(input);
  const observer = snapshotObserver(source);
  const chains: ChainDiscovery[] = [];
  for (const chainId of request.chains) {
    let snapshot: ChainSnapshot;
    try {
      snapshot = await captureChainSnapshot(observer, chainId);
    } catch {
      chains.push({ chainId, kind: "unreadable", reason: "snapshot-unreadable" });
      continue;
    }
    const resources: ResourceDiscovery[] = [];
    for (const resource of request.resources) {
      resources.push(await discoverResource(observer, snapshot, resource));
    }
    const reason = await recheckSnapshot(observer, snapshot);
    chains.push(
      reason === null
        ? { chainId, kind: "observed", snapshot, resources }
        : { chainId, kind: "unreadable", reason },
    );
  }
  return deepFreeze({ version: MOESI_DISCOVERY_VERSION, chains });
}

async function discoverResource(
  observer: MoesiObservationAdapter,
  snapshot: ChainSnapshot,
  resource: DiscoveryResourceRequest,
): Promise<ResourceDiscovery> {
  const base = { address: resource.address, caller: resource.caller };
  const code = await observeRuntimeCode(
    observer,
    Object.freeze({
      chainId: snapshot.chainId,
      address: resource.address,
      snapshot,
    }),
  );
  if (code.kind === "unreadable") return { ...base, ...code };
  if (code.code === "0x") return { ...base, kind: "missing" };
  const context = { observer, snapshot, ...base };
  const erc1967 = resource.erc1967 ? await observeERC1967(context) : null;
  const owner = resource.ownable ? await observeOwner(context) : null;
  const roles: RoleDiscovery[] = [];
  for (const query of resource.roles ?? []) roles.push(await observeRole(context, query));
  return {
    ...base,
    kind: "deployed",
    runtimeCode: code.code,
    runtimeCodeHash: keccak256(code.code),
    erc1967,
    owner,
    roles,
  };
}

async function recheckSnapshot(
  observer: MoesiObservationAdapter,
  snapshot: ChainSnapshot,
): Promise<"ancestry-unreadable" | "snapshot-not-canonical" | null> {
  try {
    const descendant = await captureChainSnapshot(observer, snapshot.chainId);
    if (
      BigInt(descendant.blockNumber) < BigInt(snapshot.blockNumber) ||
      (descendant.blockNumber === snapshot.blockNumber &&
        descendant.blockHash !== snapshot.blockHash)
    ) {
      return "snapshot-not-canonical";
    }
    const valid = await observer.checkBlockAncestry(
      Object.freeze({
        chainId: snapshot.chainId,
        ancestor: snapshot,
        descendant,
      }),
    );
    return valid === true
      ? null
      : valid === false
        ? "snapshot-not-canonical"
        : "ancestry-unreadable";
  } catch {
    return "ancestry-unreadable";
  }
}

/** Capture capabilities once while preserving the caller's adapter receiver. */
function snapshotObserver(source: MoesiObservationAdapter): MoesiObservationAdapter {
  function method<Key extends keyof MoesiObservationAdapter>(
    key: Key,
  ): MoesiObservationAdapter[Key] {
    let method: unknown;
    let unreadable = false;
    try {
      method = source[key];
    } catch {
      unreadable = true;
    }
    if (key === "readStorage" && method === undefined && !unreadable) {
      return undefined as MoesiObservationAdapter[Key];
    }
    return ((...args: unknown[]) => {
      if (typeof method !== "function") throw new Error("observation capability is unavailable");
      return Reflect.apply(method, source, args);
    }) as MoesiObservationAdapter[Key];
  }
  const readStorage = method("readStorage");
  return Object.freeze({
    captureSnapshot: method("captureSnapshot"),
    readCode: method("readCode"),
    readCall: method("readCall"),
    checkBlockAncestry: method("checkBlockAncestry"),
    ...(readStorage === undefined ? {} : { readStorage }),
  });
}
