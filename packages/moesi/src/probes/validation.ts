import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { MoesiProbeError, type MoesiProbeErrorCode } from "./error.js";

export function probeRecord(
  input: unknown,
  code: MoesiProbeErrorCode,
  allowed?: readonly string[],
): Record<string, unknown> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw null;
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (allowed !== undefined && !allowed.includes(key)) throw null;
      record[key] = Reflect.get(input, key);
    }
    return Object.freeze(record);
  } catch {
    throw new MoesiProbeError(code, "probe record is invalid or unreadable");
  }
}

export function probeArray(input: unknown, maximum: number): readonly unknown[] {
  try {
    // Bound before copying so a hostile sparse array cannot trigger a huge walk.
    if (!Array.isArray(input)) throw null;
    const length: unknown = Reflect.get(input, "length");
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximum
    )
      throw null;
    const entries: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(input, index)) throw null;
      entries.push(Reflect.get(input, index));
    }
    return Object.freeze(entries);
  } catch {
    throw new MoesiProbeError("invalid-probe-input", "probe array is invalid or exceeds its limit");
  }
}

export function probeBlockNumber(input: unknown): bigint | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "bigint" || input < 0n || input >= 1n << 256n) {
    throw new MoesiProbeError(
      "invalid-probe-input",
      "block number must be a nonnegative uint256 bigint",
    );
  }
  return input;
}

export function probeHex(input: unknown): Hex {
  if (typeof input !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input)) {
    throw new MoesiProbeError("invalid-response", "probe response must contain whole-byte hex");
  }
  return input.toLowerCase() as Hex;
}

/** ABI decoders can accept trailing/noncanonical data. Evidence must be exact. */
export function probeBooleans(input: unknown, count: number): readonly boolean[] {
  try {
    const data = probeHex(input);
    if (data.length !== 2 + (2 + count) * 64) throw null;
    const types = [{ type: "bool[]" }] as const;
    const [values] = decodeAbiParameters(types, data);
    if (values.length !== count || encodeAbiParameters(types, [values]) !== data) throw null;
    return Object.freeze([...values]);
  } catch {
    throw new MoesiProbeError("invalid-response", "probe returned an invalid boolean array");
  }
}
