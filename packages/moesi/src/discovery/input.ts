import type { Address, Hex } from "cetane";
import { MoesiDiscoveryError } from "../errors.js";
import { compareAscii, deepFreeze } from "../internal.js";
import { MAX_DISCOVERY_READS, type MoesiDiscoverRequest } from "./types.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/** All caller-owned getters/arrays are consumed once, synchronously, before RPC. */
export function parseDiscoveryRequest(value: unknown): MoesiDiscoverRequest {
  let request: MoesiDiscoverRequest;
  try {
    const root = record(value, ["chains", "resources"]);
    const chains = array(root.chains, 32).map((chain) => {
      if (typeof chain !== "number" || !Number.isSafeInteger(chain) || chain <= 0) fail();
      return chain;
    });
    if (new Set(chains).size !== chains.length) fail();
    chains.sort((a, b) => a - b);
    const resources = array(root.resources, 64).map((value) => {
      const item = record(value, ["address", "caller", "erc1967", "ownable", "roles"]);
      const target = address(item.address);
      const caller = address(item.caller);
      if (caller === ZERO_ADDRESS) fail();
      const erc1967 = flag(item.erc1967);
      const ownable = flag(item.ownable);
      const roles =
        item.roles === undefined
          ? []
          : array(item.roles, 32, true).map((value) => {
              const role = record(value, ["role", "account"]);
              if (typeof role.role !== "string" || !WORD.test(role.role)) fail();
              return { role: role.role.toLowerCase() as Hex, account: address(role.account) };
            });
      roles.sort((a, b) => compareAscii(a.role, b.role) || compareAscii(a.account, b.account));
      if (new Set(roles.map(({ role, account }) => `${role}:${account}`)).size !== roles.length)
        fail();
      return { address: target, caller, erc1967, ownable, roles };
    });
    resources.sort((a, b) => compareAscii(a.address, b.address));
    if (new Set(resources.map(({ address }) => address)).size !== resources.length) fail();
    request = deepFreeze({ chains, resources });
  } catch {
    throw new MoesiDiscoveryError("invalid_discovery_request", "discovery request is invalid");
  }
  // Worst case: initial/final snapshots, one ancestry check, code, three slots,
  // beacon view, owner view, and two views per requested role/account pair.
  const reads =
    request.chains.length *
    (3 +
      request.resources.reduce(
        (sum, resource) =>
          sum +
          1 +
          (resource.erc1967 ? 4 : 0) +
          (resource.ownable ? 1 : 0) +
          2 * (resource.roles?.length ?? 0),
        0,
      ));
  if (reads > MAX_DISCOVERY_READS) {
    throw new MoesiDiscoveryError(
      "discovery_budget_exceeded",
      "discovery request exceeds the read budget",
    );
  }
  return request;
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) fail();
  const owned = Object.create(null) as Record<string, unknown>;
  for (const key of keys) owned[key as string] = Reflect.get(value, key);
  return owned;
}

function array(value: unknown, max: number, allowEmpty = false): unknown[] {
  if (!Array.isArray(value)) fail();
  const length = Reflect.get(value, "length");
  if (!Number.isSafeInteger(length) || length < (allowEmpty ? 0 : 1) || length > max) fail();
  const owned: unknown[] = [];
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) fail();
    owned.push(Reflect.get(value, index));
  }
  return owned;
}

function address(value: unknown): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) fail();
  return value.toLowerCase() as Address;
}

function flag(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail();
  return value;
}

function fail(): never {
  throw new Error("invalid discovery input");
}
