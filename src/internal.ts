import { type Hex, keccak256, stringToHex } from "viem";
import { MoesiPlanError, type MoesiPlanErrorCode } from "./errors.js";

export function asRecord(
  value: unknown,
  path: string,
  code: MoesiPlanErrorCode = "invalid_record",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MoesiPlanError(code, path, `${path} must be a record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MoesiPlanError(code, path, `${path} must be a plain record`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) {
    throw new MoesiPlanError(
      "unknown_field",
      `${path}.${unknown}`,
      `unknown field ${path}.${unknown}`,
    );
  }
}

export function hashCanonical(value: unknown): Hex {
  return keccak256(stringToHex(JSON.stringify(canonicalize(value))));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString(10) };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
