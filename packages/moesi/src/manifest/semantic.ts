import { type Address, concatHex, type Hex, padHex } from "viem";
import { MoesiManifestError } from "../errors.js";
import { compareAscii } from "../internal.js";
import {
  ERC1967_ADMIN_SLOT,
  ERC1967_BEACON_SLOT,
  ERC1967_IMPLEMENTATION_SLOT,
} from "../observation/proxy.js";
import type { ReviewedCallCheck, ReviewedStorageCheck } from "../planning/types.js";
import { deriveResourceAddress } from "./target.js";
import type { ContractResource, SemanticCheck } from "./types.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ID = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,94}[a-zA-Z0-9])?$/;
const ZERO = "0x0000000000000000000000000000000000000000";

export function parseSemanticChecks(value: unknown): SemanticCheck[] {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value)) fail();
    const length = Reflect.get(value, "length");
    if (!Number.isSafeInteger(length) || length < 0 || length > 64) fail();
    const entries: unknown[] = [];
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(value, index)) fail();
      entries.push(Reflect.get(value, index));
    }
    const ids = new Set<string>();
    const checks = entries.map((value): SemanticCheck => {
      const item = record(value);
      if (typeof item.id !== "string" || !ID.test(item.id) || ids.has(item.id)) fail();
      ids.add(item.id);
      const id = item.id;
      if (item.kind === "ownable-owner") {
        keys(item, ["kind", "id", "caller", "expectedOwner"]);
        return {
          kind: item.kind,
          id,
          caller: address(item.caller, true),
          expectedOwner: address(item.expectedOwner),
        };
      }
      if (item.kind === "access-control-role") {
        keys(item, [
          "kind",
          "id",
          "caller",
          "role",
          "account",
          "expectedMember",
          "expectedAdminRole",
        ]);
        if (typeof item.expectedMember !== "boolean") fail();
        return {
          kind: item.kind,
          id,
          caller: address(item.caller, true),
          role: word(item.role),
          account: address(item.account),
          expectedMember: item.expectedMember,
          expectedAdminRole: word(item.expectedAdminRole),
        };
      }
      if (item.kind === "erc1967-direct") {
        keys(item, ["kind", "id", "expectedImplementation", "expectedAdmin"]);
        return {
          kind: item.kind,
          id,
          expectedImplementation: address(item.expectedImplementation, true),
          expectedAdmin: address(item.expectedAdmin),
        };
      }
      if (item.kind === "erc1967-beacon") {
        keys(item, [
          "kind",
          "id",
          "caller",
          "expectedBeacon",
          "expectedImplementation",
          "expectedAdmin",
        ]);
        return {
          kind: item.kind,
          id,
          caller: address(item.caller, true),
          expectedBeacon: address(item.expectedBeacon, true),
          expectedImplementation: address(item.expectedImplementation, true),
          expectedAdmin: address(item.expectedAdmin),
        };
      }
      return fail();
    });
    return checks.sort((a, b) => compareAscii(a.id, b.id));
  } catch {
    return fail();
  }
}

export function compileResourceChecks(resource: ContractResource): {
  readonly checks: ReviewedCallCheck[];
  readonly storageChecks: ReviewedStorageCheck[];
} {
  const target = deriveResourceAddress(resource);
  const checks: ReviewedCallCheck[] = resource.checks.map((check) => ({
    ...check,
    kind: "call",
    target,
  }));
  const storageChecks: ReviewedStorageCheck[] = resource.storageChecks.map((check) => ({
    ...check,
    kind: "word",
  }));
  for (const check of resource.semanticChecks) {
    if (check.kind === "ownable-owner") {
      checks.push({
        kind: "ownable-owner",
        id: `${check.id}.owner`,
        target,
        caller: check.caller,
        readData: "0x8da5cb5b",
        expectedResult: padHex(check.expectedOwner, { size: 32 }),
      });
    } else if (check.kind === "access-control-role") {
      checks.push({
        kind: "access-control-member",
        id: `${check.id}.member`,
        target,
        caller: check.caller,
        readData: concatHex(["0x91d14854", check.role, padHex(check.account, { size: 32 })]),
        expectedResult: padHex(check.expectedMember ? "0x01" : "0x00", { size: 32 }),
      });
      checks.push({
        kind: "access-control-admin-role",
        id: `${check.id}.admin-role`,
        target,
        caller: check.caller,
        readData: concatHex(["0x248a9ca3", check.role]),
        expectedResult: check.expectedAdminRole,
      });
    } else {
      const beacon = check.kind === "erc1967-beacon";
      storageChecks.push(
        {
          kind: "erc1967-implementation",
          id: `${check.id}.implementation`,
          slot: ERC1967_IMPLEMENTATION_SLOT,
          expectedWord: padHex(beacon ? ZERO : check.expectedImplementation, { size: 32 }),
        },
        {
          kind: "erc1967-admin",
          id: `${check.id}.admin`,
          slot: ERC1967_ADMIN_SLOT,
          expectedWord: padHex(check.expectedAdmin, { size: 32 }),
        },
        {
          kind: "erc1967-beacon",
          id: `${check.id}.beacon`,
          slot: ERC1967_BEACON_SLOT,
          expectedWord: padHex(beacon ? check.expectedBeacon : ZERO, { size: 32 }),
        },
      );
      if (beacon)
        checks.push({
          kind: "beacon-implementation",
          id: `${check.id}.beacon-implementation`,
          target: check.expectedBeacon,
          caller: check.caller,
          readData: "0x5c60da1b",
          expectedResult: padHex(check.expectedImplementation, { size: 32 }),
        });
    }
  }
  if (
    new Set(checks.map(({ id }) => id)).size !== checks.length ||
    new Set(storageChecks.map(({ id }) => id)).size !== storageChecks.length ||
    new Set(storageChecks.map(({ slot }) => slot)).size !== storageChecks.length
  )
    fail();
  checks.sort((a, b) => compareAscii(a.id, b.id));
  storageChecks.sort((a, b) => compareAscii(a.id, b.id));
  return { checks, storageChecks };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const owned = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail();
    owned[key] = Reflect.get(value, key);
  }
  return owned;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (
    Object.keys(value).length !== allowed.length ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail();
}

function address(value: unknown, nonzero = false): Address {
  if (
    typeof value !== "string" ||
    !ADDRESS.test(value) ||
    (nonzero && value.toLowerCase() === ZERO)
  )
    return fail();
  return value.toLowerCase() as Address;
}

function word(value: unknown): Hex {
  if (typeof value !== "string" || !WORD.test(value)) return fail();
  return value.toLowerCase() as Hex;
}

function fail(): never {
  throw new MoesiManifestError(
    "invalid_resource",
    "manifest.semanticChecks",
    "semantic checks are invalid or conflicting",
  );
}
