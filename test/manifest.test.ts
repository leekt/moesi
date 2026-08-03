import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { ContractResource, MoesiManifest } from "../src/index.js";
import { MoesiManifestError, parseManifest } from "../src/index.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;

function manifest(): MoesiManifest {
  return {
    version: "moesi.manifest/v1",
    contracts: [
      {
        id: "counter",
        deployment: {
          kind: "create2-factory-v1",
          factory: address("A"),
          salt: hash("b"),
          initCode: "0x60006000",
          value: "0",
        },
        expectedRuntimeCodeHash: keccak256("0x6000"),
        configuration: [],
      },
    ],
  };
}

function expectManifestError(operation: () => unknown, code: MoesiManifestError["code"]): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MoesiManifestError);
    expect((error as MoesiManifestError).code).toBe(code);
    return;
  }
  throw new Error(`expected MoesiManifestError ${code}`);
}

function firstContract(value: MoesiManifest): ContractResource {
  const contract = value.contracts[0];
  if (!contract) throw new Error("missing test contract");
  return contract;
}

function mutableFirstContract(value: Mutable<MoesiManifest>): Mutable<ContractResource> {
  const contract = value.contracts[0];
  if (!contract) throw new Error("missing mutable test contract");
  return contract;
}

describe("parseManifest", () => {
  it("normalizes and freezes the single current manifest contract", () => {
    const parsed = parseManifest(manifest());

    expect(parsed.version).toBe("moesi.manifest/v1");
    expect(parsed.contracts[0]?.deployment.factory).toBe(address("a"));
    expect(parsed.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.contracts[0]?.deployment)).toBe(true);
  });

  it("derives identity from semantic resource order", () => {
    const first = firstContract(manifest());
    const second = {
      ...first,
      id: "admin",
      deployment: { ...first.deployment, salt: hash("c") },
    };
    const left = { ...manifest(), contracts: [first, second] };
    const right = { ...manifest(), contracts: [second, first] };

    expect(parseManifest(left).manifestHash).toBe(parseManifest(right).manifestHash);
    expect(parseManifest(left).contracts.map(({ id }) => id)).toEqual(["admin", "counter"]);
  });

  it("rejects old versions, duplicate resources, and compatibility fields", () => {
    expectManifestError(
      () => parseManifest({ ...manifest(), version: "moesi.manifest/v0" } as never),
      "unsupported_manifest_version",
    );
    expectManifestError(
      () =>
        parseManifest({
          ...manifest(),
          contracts: [firstContract(manifest()), firstContract(manifest())],
        }),
      "duplicate_resource",
    );
    expectManifestError(
      () => parseManifest({ ...manifest(), schemaVersion: 1 } as never),
      "unknown_field",
    );
  });

  it("rejects empty init code and non-canonical deployment values", () => {
    const empty = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(empty).deployment.initCode = "0x";
    expectManifestError(() => parseManifest(empty), "invalid_deployment");

    const negative = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(negative).deployment.value = "-1";
    expectManifestError(() => parseManifest(negative), "invalid_deployment");

    const leadingZero = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(leadingZero).deployment.value = "01";
    expectManifestError(() => parseManifest(leadingZero), "invalid_deployment");
  });

  it("normalizes configuration order and rejects malformed rules", () => {
    const configured = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(configured).configuration = [
      {
        id: "zeta",
        readData: "0xAAAAAAAA",
        expectedResult: "0x01",
        writeData: "0xBBBBBBBB01",
        value: "0",
      },
      {
        id: "alpha",
        readData: "0xCCCCCCCC",
        expectedResult: "0x02",
        writeData: "0xDDDDDDDD02",
        value: "3",
      },
    ];
    expect(parseManifest(configured).contracts[0]?.configuration.map(({ id }) => id)).toEqual([
      "alpha",
      "zeta",
    ]);

    mutableFirstContract(configured).configuration[0]!.readData = "0x01";
    expectManifestError(() => parseManifest(configured), "invalid_resource");
  });
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
