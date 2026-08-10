import { type Address, type Hex, keccak256 } from "viem";
import { MoesiManifestError } from "../errors.js";
import {
  compareAscii,
  deepFreeze,
  hashCanonical,
  mapArrayElements,
  snapshotArray,
} from "../internal.js";
import type {
  ConfigurationRule,
  ContractResource,
  Create2FactoryDeployment,
  ManifestEnforcement,
  ManifestSender,
  MoesiManifest,
} from "./types.js";
import { MOESI_MANIFEST_VERSION } from "./types.js";

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
const EMPTY_CODE_HASH = keccak256("0x");
const RESOURCE_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/;
const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/;

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
  const contractEntries = snapshotArray(record.contracts);
  if (contractEntries === null || contractEntries.length === 0) {
    throw new MoesiManifestError(
      "invalid_manifest",
      "manifest.contracts",
      "at least one contract is required",
    );
  }
  const seen = new Set<string>();
  const seenDeployments = new Set<string>();
  const contracts = mapArrayElements(contractEntries, (entry, index) => {
    const path = `manifest.contracts[${index}]`;
    const contract = manifestRecord(entry, path, "invalid_resource");
    manifestKeys(
      contract,
      ["id", "deployment", "expectedRuntimeCodeHash", "configuration", "sender", "enforcement"],
      path,
    );
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
    const deployment = parseDeployment(contract.deployment, `${path}.deployment`);
    const deploymentKey = `${deployment.salt}:${keccak256(deployment.initCode)}`;
    if (seenDeployments.has(deploymentKey)) {
      throw new MoesiManifestError(
        "duplicate_resource",
        `${path}.deployment`,
        "multiple resources target the same deterministic deployment",
      );
    }
    seenDeployments.add(deploymentKey);
    const expectedRuntimeCodeHash = manifestBytes32(
      contract.expectedRuntimeCodeHash,
      `${path}.expectedRuntimeCodeHash`,
      "invalid_resource",
    );
    if (expectedRuntimeCodeHash === EMPTY_CODE_HASH) {
      throw new MoesiManifestError(
        "invalid_resource",
        `${path}.expectedRuntimeCodeHash`,
        "expected runtime code must not be empty",
      );
    }
    const resource: ContractResource = {
      id: contract.id,
      deployment,
      expectedRuntimeCodeHash,
      configuration: parseConfiguration(contract.configuration, `${path}.configuration`),
      ...(contract.sender === undefined
        ? {}
        : { sender: parseSender(contract.sender, `${path}.sender`) }),
      ...(contract.enforcement === undefined
        ? {}
        : { enforcement: parseEnforcement(contract.enforcement, `${path}.enforcement`) }),
    };
    return resource;
  });
  contracts.sort((left, right) => compareAscii(left.id, right.id));
  const payload = { version: MOESI_MANIFEST_VERSION, contracts } as const;
  return deepFreeze({
    ...payload,
    manifestHash: hashCanonical(payload),
  }) as unknown as ParsedManifest;
}

function parseSender(value: unknown, path: string): ManifestSender {
  const record = manifestRecord(value, path, "invalid_sender");
  if (record.kind === "owner-eoa") {
    manifestKeys(record, ["kind", "address"], path);
    return {
      kind: "owner-eoa",
      address: manifestAddress(record.address, `${path}.address`, "invalid_sender"),
    };
  }
  if (record.kind === "smart-account") {
    manifestKeys(record, ["kind", "accountId"], path);
    if (typeof record.accountId !== "string" || !ACCOUNT_ID_PATTERN.test(record.accountId)) {
      throw new MoesiManifestError("invalid_sender", `${path}.accountId`, "account id is invalid");
    }
    return { kind: "smart-account", accountId: record.accountId };
  }
  throw new MoesiManifestError("invalid_sender", `${path}.kind`, "sender kind is invalid");
}

function parseEnforcement(value: unknown, path: string): ManifestEnforcement {
  const record = manifestRecord(value, path, "invalid_enforcement");
  manifestKeys(record, ["callScope", "expiry", "operationLimit"], path);
  if (
    record.callScope !== "required-onchain" &&
    record.callScope !== "interactive-review-sufficient"
  ) {
    throw new MoesiManifestError(
      "invalid_enforcement",
      `${path}.callScope`,
      "callScope is invalid",
    );
  }
  if (record.expiry !== "required" && record.expiry !== "optional") {
    throw new MoesiManifestError("invalid_enforcement", `${path}.expiry`, "expiry is invalid");
  }
  if (record.operationLimit !== "required" && record.operationLimit !== "optional") {
    throw new MoesiManifestError(
      "invalid_enforcement",
      `${path}.operationLimit`,
      "operationLimit is invalid",
    );
  }
  return {
    callScope: record.callScope,
    expiry: record.expiry,
    operationLimit: record.operationLimit,
  };
}

function parseConfiguration(value: unknown, path: string): ConfigurationRule[] {
  const entries = snapshotArray(value);
  if (entries === null) {
    throw new MoesiManifestError("invalid_resource", path, "configuration must be an array");
  }
  const seen = new Set<string>();
  const configuration = mapArrayElements(entries, (entry, index) => {
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
  configuration.sort((left, right) => compareAscii(left.id, right.id));
  return configuration;
}

function parseDeployment(value: unknown, path: string): Create2FactoryDeployment {
  const record = manifestRecord(value, path, "invalid_deployment");
  manifestKeys(record, ["kind", "salt", "initCode", "value"], path);
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
    salt: manifestBytes32(record.salt, `${path}.salt`, "invalid_deployment"),
    initCode,
    value: record.value,
  };
}

function manifestRecord(
  value: unknown,
  path: string,
  code:
    | "invalid_manifest"
    | "invalid_resource"
    | "invalid_deployment"
    | "invalid_sender"
    | "invalid_enforcement",
): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new MoesiManifestError(code, path, `${path} must be a record`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MoesiManifestError(code, path, `${path} must be a plain record`);
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) snapshot[key] = Reflect.get(value, key);
    return snapshot;
  } catch (error) {
    if (error instanceof MoesiManifestError) throw error;
    throw new MoesiManifestError(code, path, `${path} must be a readable plain record`);
  }
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
  code: "invalid_resource" | "invalid_deployment" | "invalid_sender",
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
