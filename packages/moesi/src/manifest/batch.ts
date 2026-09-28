import {
  type AbiParameter,
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  type Hex,
} from "viem";
import { MoesiManifestError } from "../errors.js";
import { hashCanonical, snapshotArray } from "../internal.js";
import type {
  ConfigurationBatch,
  ConfigurationBatchParameter,
  ConfigurationRule,
} from "./types.js";

function invalid(path: string): never {
  throw new MoesiManifestError("invalid_resource", path, "configuration batch is invalid");
}

export function parseConfigurationBatch(input: unknown, path: string): ConfigurationBatch {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid(path);
  const entries = Object.getOwnPropertyDescriptors(input);
  if (
    Object.keys(entries).length !== 3 ||
    ["key", "parameters", "maxRows"].some((key) => !entries[key] || !("value" in entries[key]!))
  )
    return invalid(path);
  const key = entries.key!.value as unknown;
  const parameters = snapshotArray(entries.parameters!.value);
  const maxRows = entries.maxRows!.value as unknown;
  if (
    typeof key !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(key) ||
    typeof maxRows !== "number" ||
    !Number.isInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 256 ||
    parameters === null ||
    parameters.length < 1 ||
    parameters.length > 32
  )
    return invalid(path);
  for (const type of parameters) {
    if (typeof type !== "string") return invalid(path);
    if (["address[]", "bool[]", "bytes[]", "string[]"].includes(type)) continue;
    const uint = /^(?:uint|int)([0-9]+)\[\]$/.exec(type);
    const bytes = /^bytes([0-9]+)\[\]$/.exec(type);
    if (
      uint &&
      Number(uint[1]) >= 8 &&
      Number(uint[1]) <= 256 &&
      Number(uint[1]) % 8 === 0 &&
      String(Number(uint[1])) === uint[1]
    )
      continue;
    if (
      bytes &&
      Number(bytes[1]) >= 1 &&
      Number(bytes[1]) <= 32 &&
      String(Number(bytes[1])) === bytes[1]
    )
      continue;
    return invalid(path);
  }
  return { key, parameters: parameters as ConfigurationBatchParameter[], maxRows };
}

/** Exact canonical one-row ABI arguments; no raw offsets or partial encodings survive. */
function decodeRow(rule: ConfigurationRule): readonly unknown[] {
  const batch = rule.batch;
  if (!batch || rule.value !== "0") return invalid(`configuration.${rule.id}.batch`);
  try {
    const parameters = batch.parameters.map((type) => ({ type })) as readonly AbiParameter[];
    const encoded = `0x${rule.writeData.slice(10)}` as Hex;
    const decoded = decodeAbiParameters(parameters, encoded);
    if (
      decoded.some((column) => !Array.isArray(column) || column.length !== 1) ||
      encodeAbiParameters(parameters, decoded) !== encoded
    )
      return invalid(`configuration.${rule.id}.writeData`);
    return decoded.map((column) => (column as readonly unknown[])[0]);
  } catch {
    return invalid(`configuration.${rule.id}.writeData`);
  }
}

/** Validate grouping once after byte references have become literal calldata. */
export function validateConfigurationBatches(rules: readonly ConfigurationRule[]): void {
  const completed = new Set<string>();
  let previous: ConfigurationRule | undefined;
  for (const rule of rules) {
    if (previous?.batch && previous.batch.key !== rule.batch?.key)
      completed.add(previous.batch.key);
    if (rule.batch) {
      if (completed.has(rule.batch.key)) invalid(`configuration.${rule.id}.batch`);
      if (
        previous?.batch?.key === rule.batch.key &&
        (hashCanonical(previous.batch) !== hashCanonical(rule.batch) ||
          previous.writeData.slice(0, 10) !== rule.writeData.slice(0, 10))
      )
        invalid(`configuration.${rule.id}.batch`);
      decodeRow(rule);
    }
    previous = rule;
  }
}

export function mergeConfigurationWrites(rules: readonly ConfigurationRule[]): Hex {
  const first = rules[0];
  if (!first?.batch || rules.length > first.batch.maxRows) return invalid("configuration.batch");
  const rows = rules.map(decodeRow);
  const columns = first.batch.parameters.map((_, index) => rows.map((row) => row[index]));
  return concatHex([
    first.writeData.slice(0, 10) as Hex,
    encodeAbiParameters(
      first.batch.parameters.map((type) => ({ type })) as readonly AbiParameter[],
      columns,
    ),
  ]);
}
