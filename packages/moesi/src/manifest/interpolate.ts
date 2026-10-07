import type { Address, Hex } from "cetane";
import { concatHex, padHex } from "cetane/utils";
import { MoesiManifestError } from "../errors.js";
import { mapArrayElements, snapshotArray } from "../internal.js";
import type {
  ContractResource,
  ManifestBytes,
  ManifestContractResource,
  ResourceAddressWord,
} from "./types.js";

const ID = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

function invalid(path: string): never {
  throw new MoesiManifestError("invalid_reference", path, "manifest byte expression is invalid");
}

function record(value: unknown, path: string): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(path);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid(path);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) result[key] = Reflect.get(value, key);
    return result;
  } catch {
    return invalid(path);
  }
}

function atom(value: unknown, path: string): Hex | ResourceAddressWord {
  if (typeof value === "string") {
    if (!HEX.test(value)) return invalid(path);
    return value.toLowerCase() as Hex;
  }
  return addressWord(record(value, path), path);
}

function addressWord(value: Record<string, unknown>, path: string): ResourceAddressWord {
  if (
    Object.keys(value).length !== 2 ||
    value.kind !== "resource-address-word" ||
    typeof value.resourceId !== "string" ||
    !ID.test(value.resourceId)
  )
    return invalid(path);
  return { kind: "resource-address-word", resourceId: value.resourceId };
}

/** Captures expressions once at the caller boundary; nested concatenation is invalid. */
export function parseManifestBytes(value: unknown, path: string): ManifestBytes {
  if (typeof value === "string") {
    if (!HEX.test(value))
      throw new MoesiManifestError("invalid_resource", path, "hex value is invalid");
    return value.toLowerCase() as Hex;
  }
  if (typeof value !== "object" || value === null)
    throw new MoesiManifestError(
      "invalid_resource",
      path,
      "byte value must be hex or a reference expression",
    );
  const object = record(value, path);
  if (object.kind !== "concat") return addressWord(object, path);
  if (Object.keys(object).length !== 2) return invalid(path);
  const parts = snapshotArray(object.parts);
  if (parts === null || parts.length === 0 || parts.length > 256) return invalid(path);
  return {
    kind: "concat",
    parts: mapArrayElements(parts, (part, index) => atom(part, `${path}.parts[${index}]`)),
  };
}

export function manifestBytesLength(value: ManifestBytes): number {
  if (typeof value === "string") return (value.length - 2) / 2;
  if (value.kind === "resource-address-word") return 32;
  return value.parts.reduce((sum, part) => sum + manifestBytesLength(part), 0);
}

function resolveBytes(value: ManifestBytes, addresses: ReadonlyMap<string, Address>): Hex {
  if (typeof value === "string") return value;
  if (value.kind === "concat")
    return concatHex(value.parts.map((part) => resolveBytes(part, addresses)));
  const address = addresses.get(value.resourceId);
  if (address === undefined)
    throw new MoesiManifestError(
      "unknown_reference",
      "manifest",
      "manifest reference names an unknown resource",
    );
  return padHex(address, { size: 32 });
}

export function resolveManifestResource(
  resource: ManifestContractResource,
  addresses: ReadonlyMap<string, Address>,
): ContractResource {
  const fields = {
    semanticChecks: resource.semanticChecks ?? [],
    checks: resource.checks.map((check) => ({
      ...check,
      readData: resolveBytes(check.readData, addresses),
      expectedResult: resolveBytes(check.expectedResult, addresses),
    })),
    storageChecks: resource.storageChecks.map((check) => ({
      ...check,
      expectedWord: resolveBytes(check.expectedWord, addresses),
    })),
  };
  if (resource.kind === "external") return { ...resource, ...fields };
  return {
    ...resource,
    ...fields,
    configuration: resource.configuration.map((rule) => ({
      ...rule,
      readData: resolveBytes(rule.readData, addresses),
      expectedResult: resolveBytes(rule.expectedResult, addresses),
      writeData: resolveBytes(rule.writeData, addresses),
    })),
  };
}
