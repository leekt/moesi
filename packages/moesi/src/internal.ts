import type { Hex } from "cetane";
import { keccak256, stringToHex } from "cetane/utils";
import { MoesiPlanError, type MoesiPlanErrorCode } from "./errors.js";

export function asRecord(
  value: unknown,
  path: string,
  code: MoesiPlanErrorCode = "invalid_record",
): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new MoesiPlanError(code, path, `${path} must be a record`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MoesiPlanError(code, path, `${path} must be a plain record`);
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) snapshot[key] = Reflect.get(value, key);
    return snapshot;
  } catch (error) {
    if (error instanceof MoesiPlanError) throw error;
    throw new MoesiPlanError(code, path, `${path} must be a readable plain record`);
  }
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

export function snapshotArray(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = Reflect.get(value, "length");
    if (!Number.isSafeInteger(length) || length < 0) return null;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) return null;
      snapshot.push(Reflect.get(value, index));
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function mapArrayElements<Input, Output>(
  value: readonly Input[],
  mapper: (entry: Input, index: number) => Output,
): Output[] {
  const output: Output[] = [];
  for (let index = 0; index < value.length; index += 1) {
    output.push(mapper(value[index] as Input, index));
  }
  return output;
}

export function hashCanonical(value: unknown): Hex {
  return keccak256(stringToHex(JSON.stringify(canonicalize(value))));
}

/** Locale-independent ordering for canonical ASCII ids and object keys. */
export function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString(10) };
  if (Array.isArray(value)) {
    const snapshot = snapshotArray(value);
    if (snapshot === null) throw new Error("array is unreadable");
    return mapArrayElements(snapshot, canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareAscii(left, right))
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
