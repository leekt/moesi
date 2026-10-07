import type { Address } from "cetane";
import { deepFreeze, hashCanonical } from "../internal.js";
import { throwIfObservationStopped } from "../observation/failure.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "../observation/types.js";
import { compareAccountModules, parseModuleInventory } from "./codec.js";
import type { AccountModulesExpectation, AccountModulesObservation } from "./types.js";

export async function observeAccountModules(
  observer: MoesiObservationAdapter,
  account: Address,
  snapshot: ChainSnapshot,
  expectation: AccountModulesExpectation,
): Promise<AccountModulesObservation> {
  let value: unknown;
  try {
    if (!observer.readAccountModules) return { kind: "unreadable", reason: "unavailable" };
    value = await observer.readAccountModules(
      deepFreeze({ address: account, chainId: snapshot.chainId, snapshot, expectation }),
    );
  } catch (error) {
    throwIfObservationStopped(error);
    return { kind: "unreadable", reason: "read-failed" };
  }
  try {
    return compareAccountModules(
      expectation,
      parseModuleInventory(value, { account, snapshot, expectation }),
    );
  } catch {
    return { kind: "unreadable", reason: "invalid-response" };
  }
}

/** Recompute the business result from retained, strictly pinned inventory evidence. */
export function parseModulesObservation(
  value: unknown,
  bound: { account: Address; snapshot: ChainSnapshot; expectation: AccountModulesExpectation },
): AccountModulesObservation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_module_observation");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !("value" in fields[key]!)))
    throw new Error("invalid_module_observation");
  const kind = fields.kind?.value;
  if (kind === "unreadable") {
    if (
      Object.keys(fields).length !== 2 ||
      !["unavailable", "read-failed", "invalid-response"].includes(fields.reason?.value)
    )
      throw new Error("invalid_module_observation");
    return { kind, reason: fields.reason!.value };
  }
  const inventory = parseModuleInventory(fields.inventory?.value, bound);
  const rebuilt = compareAccountModules(bound.expectation, inventory);
  if (hashCanonical(value) !== hashCanonical(rebuilt))
    throw new Error("invalid_module_observation");
  return rebuilt;
}
