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
          salt: hash("B"),
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
    expect(parsed.contracts[0]?.deployment.salt).toBe(hash("b"));
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

    const ambiguousId = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(ambiguousId).id = "x:configure:y";
    expectManifestError(() => parseManifest(ambiguousId), "invalid_resource");
    expectManifestError(
      () => parseManifest({ ...manifest(), schemaVersion: 1 } as never),
      "unknown_field",
    );

    const customFactory = structuredClone(manifest()) as unknown as {
      contracts: Array<{ deployment: Record<string, unknown> }>;
    };
    const customDeployment = customFactory.contracts[0]?.deployment;
    if (!customDeployment) throw new Error("missing custom deployment fixture");
    customDeployment.factory = address("a");
    expectManifestError(() => parseManifest(customFactory as never), "unknown_field");

    const duplicateDeployment = firstContract(manifest());
    expectManifestError(
      () =>
        parseManifest({
          ...manifest(),
          contracts: [duplicateDeployment, { ...duplicateDeployment, id: "same-address" }],
        }),
      "duplicate_resource",
    );
  });

  it("rejects sparse resource and configuration arrays", () => {
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v1",
          contracts: new Array(1),
        } as never),
      "invalid_manifest",
    );

    const sparseConfiguration = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(sparseConfiguration).configuration = new Array(1);
    expectManifestError(() => parseManifest(sparseConfiguration), "invalid_resource");
  });

  it("does not dispatch through caller-owned array methods", () => {
    const valid = firstContract(manifest());
    const contracts = [{ ...valid, id: "invalid:resource" }];
    Object.defineProperty(contracts, "map", { value: () => [valid] });

    expectManifestError(
      () => parseManifest({ version: "moesi.manifest/v1", contracts } as MoesiManifest),
      "invalid_resource",
    );
  });

  it("snapshots record fields and array lengths exactly once", () => {
    const valid = firstContract(manifest());
    let contractsReads = 0;
    let lengthReads = 0;
    const contracts = new Proxy([valid], {
      get(target, key, receiver) {
        if (key === "length") lengthReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const source = Object.defineProperty({ version: "moesi.manifest/v1" }, "contracts", {
      enumerable: true,
      get() {
        contractsReads += 1;
        return contractsReads === 1 ? contracts : [];
      },
    });

    expect(parseManifest(source as MoesiManifest).contracts).toHaveLength(1);
    expect(contractsReads).toBe(1);
    expect(lengthReads).toBe(1);
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

  it("rejects the empty runtime-code hash", () => {
    const emptyRuntime = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(emptyRuntime).expectedRuntimeCodeHash = keccak256("0x");
    expectManifestError(() => parseManifest(emptyRuntime), "invalid_resource");
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

    const firstRule = mutableFirstContract(configured).configuration[0];
    if (!firstRule) throw new Error("missing test configuration");
    firstRule.readData = "0x01";
    expectManifestError(() => parseManifest(configured), "invalid_resource");
  });

  it("parses and freezes an optional owner EOA sender", () => {
    const withSender = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(withSender).sender = { kind: "owner-eoa", address: address("E") };

    const parsed = parseManifest(withSender);
    expect(parsed.contracts[0]?.sender).toEqual({
      kind: "owner-eoa",
      address: address("e"),
    });
    expect(Object.isFrozen(parsed.contracts[0]?.sender)).toBe(true);
  });

  it("parses an optional smart-account sender", () => {
    const withSender = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(withSender).sender = {
      kind: "smart-account",
      accountId: "kernel:main",
    };

    expect(parseManifest(withSender).contracts[0]?.sender).toEqual({
      kind: "smart-account",
      accountId: "kernel:main",
    });
  });

  it("rejects malformed sender declarations", () => {
    const badAddress = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(badAddress).sender = { kind: "owner-eoa", address: "0x1234" as never };
    expectManifestError(() => parseManifest(badAddress), "invalid_sender");

    const badAccount = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(badAccount).sender = { kind: "smart-account", accountId: "" };
    expectManifestError(() => parseManifest(badAccount), "invalid_sender");

    const unknownKind = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(unknownKind).sender = { kind: "any" } as never;
    expectManifestError(() => parseManifest(unknownKind), "invalid_sender");

    const extraField = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(extraField).sender = {
      kind: "owner-eoa",
      address: address("E"),
      note: "x",
    } as never;
    expectManifestError(() => parseManifest(extraField), "unknown_field");
  });

  it("parses explicit enforcement and rejects partial declarations", () => {
    const enforced = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(enforced).enforcement = {
      callScope: "required-onchain",
      expiry: "required",
      operationLimit: "optional",
    };
    expect(parseManifest(enforced).contracts[0]?.enforcement).toEqual({
      callScope: "required-onchain",
      expiry: "required",
      operationLimit: "optional",
    });

    const partial = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(partial).enforcement = { callScope: "required-onchain" } as never;
    expectManifestError(() => parseManifest(partial), "invalid_enforcement");

    const invalid = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(invalid).enforcement = {
      callScope: "sometimes",
      expiry: "required",
      operationLimit: "optional",
    } as never;
    expectManifestError(() => parseManifest(invalid), "invalid_enforcement");
  });

  it("keeps identity stable when optional declarations are absent", () => {
    const plain = parseManifest(manifest());
    const alsoPlain = parseManifest(manifest());
    expect(plain.manifestHash).toBe(alsoPlain.manifestHash);
    expect(plain.contracts[0]?.sender).toBeUndefined();
    expect(plain.contracts[0]?.enforcement).toBeUndefined();
  });
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
