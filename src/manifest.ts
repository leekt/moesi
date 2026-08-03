import type { Address, Hex } from "viem";
import { MoesiManifestError } from "./errors.js";
import { deepFreeze, hashCanonical } from "./internal.js";

export const MOESI_MANIFEST_VERSION = "moesi.manifest/v1" as const;

export interface Create2FactoryDeployment {
  readonly kind: "create2-factory-v1";
  readonly factory: Address;
  readonly salt: Hex;
  readonly initCode: Hex;
  /** Canonical decimal uint256 string so the manifest remains JSON-safe. */
  readonly value: string;
}

export interface ContractResource {
  readonly id: string;
  readonly deployment: Create2FactoryDeployment;
  readonly expectedRuntimeCodeHash: Hex;
  readonly configuration: readonly ConfigurationRule[];
}

export interface ConfigurationRule {
  readonly id: string;
  readonly readData: Hex;
  readonly expectedResult: Hex;
  readonly writeData: Hex;
  /** Canonical decimal uint256 string so the manifest remains JSON-safe. */
  readonly value: string;
}

export interface MoesiManifest {
  readonly version: "moesi.manifest/v1";
  readonly contracts: readonly ContractResource[];
}

declare const parsedManifestBrand: unique symbol;

export interface ParsedManifest extends MoesiManifest {
  readonly [parsedManifestBrand]: true;
  readonly manifestHash: Hex;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT256_PATTERN = /^(?:0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const RESOURCE_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/;

export function parseManifest(input: MoesiManifest): ParsedManifest;
export function parseManifest(input: unknown): ParsedManifest {
  const record = manifestRecord(input, "manifest", "invalid_manifest");
  manifestKeys(record, ["version", "contracts"], "manifest");
  if (record.version !== MOESI_MANIFEST_VERSION) {
    throw new MoesiManifestError(
      "unsupported_manifest_version",
      "manifest.version",
      `manifest version must be ${MOESI_MANIFEST_VERSION}`,
    );
  }
  if (!Array.isArray(record.contracts) || record.contracts.length === 0) {
    throw new MoesiManifestError(
      "invalid_manifest",
      "manifest.contracts",
      "at least one contract is required",
    );
  }
  const seen = new Set<string>();
  const contracts = record.contracts.map((entry, index) => {
    const path = `manifest.contracts[${index}]`;
    const contract = manifestRecord(entry, path, "invalid_resource");
    manifestKeys(contract, ["id", "deployment", "expectedRuntimeCodeHash", "configuration"], path);
    if (typeof contract.id !== "string" || !RESOURCE_ID_PATTERN.test(contract.id)) {
      throw new MoesiManifestError("invalid_resource", `${path}.id`, "resource id is invalid");
    }
    if (seen.has(contract.id)) {
      throw new MoesiManifestError(
        "duplicate_resource",
        `${path}.id`,
        `duplicate resource ${contract.id}`,
      );
    }
    seen.add(contract.id);
    return {
      id: contract.id,
      deployment: parseDeployment(contract.deployment, `${path}.deployment`),
      expectedRuntimeCodeHash: manifestBytes32(
        contract.expectedRuntimeCodeHash,
        `${path}.expectedRuntimeCodeHash`,
        "invalid_resource",
      ),
      configuration: parseConfiguration(contract.configuration, `${path}.configuration`),
    };
  });
  contracts.sort((left, right) => left.id.localeCompare(right.id));
  const payload = { version: MOESI_MANIFEST_VERSION, contracts } as const;
  return deepFreeze({
    ...payload,
    manifestHash: hashCanonical(payload),
  }) as unknown as ParsedManifest;
}

function parseConfiguration(value: unknown, path: string): ConfigurationRule[] {
  if (!Array.isArray(value)) {
    throw new MoesiManifestError("invalid_resource", path, "configuration must be an array");
  }
  const seen = new Set<string>();
  const configuration = value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const rule = manifestRecord(entry, itemPath, "invalid_resource");
    manifestKeys(rule, ["id", "readData", "expectedResult", "writeData", "value"], itemPath);
    if (typeof rule.id !== "string" || !RESOURCE_ID_PATTERN.test(rule.id)) {
      throw new MoesiManifestError(
        "invalid_resource",
        `${itemPath}.id`,
        "configuration id is invalid",
      );
    }
    if (seen.has(rule.id)) {
      throw new MoesiManifestError(
        "invalid_resource",
        `${itemPath}.id`,
        `duplicate configuration ${rule.id}`,
      );
    }
    seen.add(rule.id);
    const readData = manifestHex(rule.readData, `${itemPath}.readData`, "invalid_resource");
    const writeData = manifestHex(rule.writeData, `${itemPath}.writeData`, "invalid_resource");
    if (readData.length < 10) {
      throw new MoesiManifestError(
        "invalid_resource",
        `${itemPath}.readData`,
        "readData must include a selector",
      );
    }
    if (writeData.length < 10) {
      throw new MoesiManifestError(
        "invalid_resource",
        `${itemPath}.writeData`,
        "writeData must include a selector",
      );
    }
    if (
      typeof rule.value !== "string" ||
      !UINT256_PATTERN.test(rule.value) ||
      BigInt(rule.value) > MAX_UINT256
    ) {
      throw new MoesiManifestError(
        "invalid_resource",
        `${itemPath}.value`,
        "configuration value must be a canonical decimal uint256 string",
      );
    }
    return {
      id: rule.id,
      readData,
      expectedResult: manifestHex(
        rule.expectedResult,
        `${itemPath}.expectedResult`,
        "invalid_resource",
      ),
      writeData,
      value: rule.value,
    };
  });
  configuration.sort((left, right) => left.id.localeCompare(right.id));
  return configuration;
}

function parseDeployment(value: unknown, path: string): Create2FactoryDeployment {
  const record = manifestRecord(value, path, "invalid_deployment");
  manifestKeys(record, ["kind", "factory", "salt", "initCode", "value"], path);
  if (record.kind !== "create2-factory-v1") {
    throw new MoesiManifestError(
      "invalid_deployment",
      `${path}.kind`,
      "deployment kind is invalid",
    );
  }
  const initCode = manifestHex(record.initCode, `${path}.initCode`, "invalid_deployment");
  if (initCode === "0x") {
    throw new MoesiManifestError(
      "invalid_deployment",
      `${path}.initCode`,
      "initCode must not be empty",
    );
  }
  if (
    typeof record.value !== "string" ||
    !UINT256_PATTERN.test(record.value) ||
    BigInt(record.value) > MAX_UINT256
  ) {
    throw new MoesiManifestError(
      "invalid_deployment",
      `${path}.value`,
      "deployment value must be a canonical decimal uint256 string",
    );
  }
  return {
    kind: "create2-factory-v1",
    factory: manifestAddress(record.factory, `${path}.factory`, "invalid_deployment"),
    salt: manifestBytes32(record.salt, `${path}.salt`, "invalid_deployment"),
    initCode,
    value: record.value,
  };
}

function manifestRecord(
  value: unknown,
  path: string,
  code: "invalid_manifest" | "invalid_resource" | "invalid_deployment",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MoesiManifestError(code, path, `${path} must be a record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MoesiManifestError(code, path, `${path} must be a plain record`);
  }
  return value as Record<string, unknown>;
}

function manifestKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) {
    throw new MoesiManifestError(
      "unknown_field",
      `${path}.${unknown}`,
      `unknown field ${path}.${unknown}`,
    );
  }
}

function manifestAddress(
  value: unknown,
  path: string,
  code: "invalid_resource" | "invalid_deployment",
): Address {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new MoesiManifestError(code, path, "address is invalid");
  }
  return value.toLowerCase() as Address;
}

function manifestHex(
  value: unknown,
  path: string,
  code: "invalid_resource" | "invalid_deployment",
): Hex {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    throw new MoesiManifestError(code, path, "hex value is invalid");
  }
  return value.toLowerCase() as Hex;
}

function manifestBytes32(
  value: unknown,
  path: string,
  code: "invalid_resource" | "invalid_deployment",
): Hex {
  if (typeof value !== "string" || !BYTES32_PATTERN.test(value)) {
    throw new MoesiManifestError(code, path, "bytes32 value is invalid");
  }
  return value.toLowerCase() as Hex;
}
