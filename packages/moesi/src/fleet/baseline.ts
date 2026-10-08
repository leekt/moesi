import type { Address, Hex } from "cetane";
import { keccak256 } from "cetane/utils";
import { compareAscii, deepFreeze, hashCanonical, snapshotArray } from "../internal.js";
import { parseConfigurationPeers } from "../manifest/peers.js";
import { isValidCallCheckResult } from "../observation/checks.js";
import type { ReviewedCallCheck } from "../planning/types.js";
import {
  type FleetBaseline,
  type FleetBaselineCall,
  type FleetBaselineCell,
  type FleetBaselineConfiguration,
  type FleetBaselineStorage,
  MOESI_FLEET_BASELINE_VERSION,
  MoesiFleetParityError,
} from "./parity-types.js";

const owned = new WeakSet<object>();
const invalid = (): never => {
  throw new MoesiFleetParityError("invalid_fleet_baseline");
};
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) => !descriptors[key] || !("value" in descriptors[key]!))
  )
    return invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value))
    return invalid();
  return value;
}
function hex(value: unknown, bytes?: number): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[a-fA-F0-9]{2})*$/.test(value) ||
    value.length > 2_097_154 ||
    (bytes !== undefined && value.length !== 2 + bytes * 2)
  )
    return invalid();
  return value.toLowerCase() as Hex;
}
function address(value: unknown, zero = false): Address {
  const parsed = hex(value, 20);
  if (!zero && /^0x0{40}$/.test(parsed)) return invalid();
  return parsed;
}
function array<T>(value: unknown, parse: (entry: unknown) => T): T[] {
  const entries = snapshotArray(value);
  if (!entries || entries.length > 16_384) return invalid();
  return entries.map(parse);
}
export function parityReadKey(
  kind: "configuration" | "call" | "storage",
  value: FleetBaselineConfiguration | FleetBaselineCall | FleetBaselineStorage,
): string {
  return hashCanonical(
    kind === "storage" && "slot" in value
      ? { kind, slot: value.slot }
      : {
          kind,
          ...("target" in value ? { target: value.target } : {}),
          ...("caller" in value ? { caller: value.caller, readData: value.readData } : {}),
        },
  );
}
function uniqueReads<
  T extends FleetBaselineConfiguration | FleetBaselineCall | FleetBaselineStorage,
>(kind: "configuration" | "call" | "storage", values: T[]): T[] {
  if (
    new Set(values.map((value) => parityReadKey(kind, value))).size !== values.length ||
    new Set(values.map(({ id }) => id)).size !== values.length
  )
    return invalid();
  return values.sort((a, b) => compareAscii(parityReadKey(kind, a), parityReadKey(kind, b)));
}
function call(input: Record<string, unknown>) {
  const readData = hex(input.readData);
  if (readData.length < 10) return invalid();
  return {
    id: id(input.id),
    caller: address(input.caller, true),
    readData,
    expectedResult: hex(input.expectedResult),
  };
}
/** Parse one current, closed schema. Older application manifests never enter this boundary. */
export function parseFleetBaseline(input: unknown): FleetBaseline {
  if (typeof input === "object" && input !== null && owned.has(input))
    return input as FleetBaseline;
  try {
    // Check the outer version before shape validation so stale artifacts fail uniformly.
    const version =
      typeof input === "object" && input !== null
        ? Object.getOwnPropertyDescriptor(input, "version")
        : undefined;
    if (!version || !("value" in version) || version.value !== MOESI_FLEET_BASELINE_VERSION)
      throw new MoesiFleetParityError("unsupported_fleet_baseline_version");
    const root = record(input, ["version", "cells"]);
    const cells = array(root.cells, (value): FleetBaselineCell => {
      const cell = record(value, [
        "chainId",
        "resourceId",
        "kind",
        "address",
        "expectedRuntimeCodeHash",
        "configuration",
        "checks",
        "storageChecks",
      ]);
      if (
        typeof cell.chainId !== "number" ||
        !Number.isSafeInteger(cell.chainId) ||
        cell.chainId <= 0 ||
        (cell.kind !== "managed" && cell.kind !== "external")
      )
        return invalid();
      const runtimeHash = hex(cell.expectedRuntimeCodeHash, 32);
      if (runtimeHash === keccak256("0x")) return invalid();
      const configuration = uniqueReads(
        "configuration",
        array(cell.configuration, (entry) => {
          const row = record(entry, ["id", "caller", "readData", "expectedResult", "after"]);
          return { ...call(row), after: parseConfigurationPeers(row.after, "baseline.peers") };
        }),
      );
      if (cell.kind === "external" && configuration.length > 0) return invalid();
      return {
        chainId: cell.chainId,
        resourceId: id(cell.resourceId),
        kind: cell.kind,
        address: address(cell.address),
        expectedRuntimeCodeHash: runtimeHash,
        configuration,
        checks: uniqueReads(
          "call",
          array(cell.checks, (entry) => {
            const row = record(entry, [
              "kind",
              "id",
              "target",
              "caller",
              "readData",
              "expectedResult",
            ]);
            if (
              ![
                "call",
                "uint256-minimum",
                "ownable-owner",
                "access-control-member",
                "access-control-admin-role",
                "beacon-implementation",
              ].includes(row.kind as string)
            )
              return invalid();
            const check = {
              ...call(row),
              kind: row.kind as ReviewedCallCheck["kind"],
              target: address(row.target),
            };
            if (!isValidCallCheckResult(check, check.expectedResult)) return invalid();
            return check;
          }),
        ),
        storageChecks: uniqueReads(
          "storage",
          array(cell.storageChecks, (entry) => {
            const row = record(entry, ["id", "slot", "expectedWord"]);
            return {
              id: id(row.id),
              slot: hex(row.slot, 32),
              expectedWord: hex(row.expectedWord, 32),
            };
          }),
        ),
      };
    });
    if (
      cells.length === 0 ||
      new Set(cells.map((cell) => `${cell.chainId}:${cell.resourceId}`)).size !== cells.length ||
      new Set(cells.map((cell) => `${cell.chainId}:${cell.address}`)).size !== cells.length
    )
      return invalid();
    cells.sort((a, b) => a.chainId - b.chainId || compareAscii(a.resourceId, b.resourceId));
    const result = deepFreeze({ version: MOESI_FLEET_BASELINE_VERSION, cells });
    owned.add(result);
    return result;
  } catch (error) {
    if (error instanceof MoesiFleetParityError) throw error;
    return invalid();
  }
}
