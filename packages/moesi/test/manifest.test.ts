import { getCreate2Address, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { ContractResource, MoesiManifest } from "../src/index.js";
import { CREATE2_FACTORY_V1_ADDRESS, MoesiManifestError, parseManifest } from "../src/index.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;

type ManagedContractResource = Extract<ContractResource, { readonly kind: "managed" }>;
type ExternalContractResource = Extract<ContractResource, { readonly kind: "external" }>;
type ManagedManifest = Omit<MoesiManifest, "contracts"> & {
  readonly contracts: readonly ManagedContractResource[];
};

function manifest(): ManagedManifest {
  return {
    version: "moesi.manifest/v1",
    contracts: [
      {
        kind: "managed",
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

function externalResource(input: Partial<ExternalContractResource> = {}): ExternalContractResource {
  return {
    kind: "external",
    id: "registry",
    address: address("A"),
    expectedRuntimeCodeHash: hash("D"),
    ...input,
  };
}

function expectManifestError(
  operation: () => unknown,
  code: MoesiManifestError["code"],
  path?: string,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MoesiManifestError);
    expect((error as MoesiManifestError).code).toBe(code);
    if (path !== undefined) expect((error as MoesiManifestError).path).toBe(path);
    return;
  }
  throw new Error(`expected MoesiManifestError ${code}`);
}

function firstContract(value: MoesiManifest): ManagedContractResource {
  const contract = value.contracts[0];
  if (!contract) throw new Error("missing test contract");
  if (contract.kind !== "managed") throw new Error("expected managed test contract");
  return contract;
}

function mutableFirstContract(value: Mutable<MoesiManifest>): Mutable<ManagedContractResource> {
  const contract = value.contracts[0];
  if (!contract) throw new Error("missing mutable test contract");
  if (contract.kind !== "managed") throw new Error("expected mutable managed test contract");
  return contract;
}

describe("parseManifest", () => {
  it("normalizes and freezes the single current manifest contract", () => {
    const parsed = parseManifest(manifest());
    const managed = firstContract(parsed);

    expect(parsed.version).toBe("moesi.manifest/v1");
    expect(managed.kind).toBe("managed");
    expect(managed.deployment.salt).toBe(hash("b"));
    expect(parsed.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(managed.deployment)).toBe(true);
  });

  it("normalizes and freezes exact-address external resources", () => {
    const parsed = parseManifest({
      version: "moesi.manifest/v1",
      contracts: [
        firstContract(manifest()),
        externalResource({ address: address("A"), expectedRuntimeCodeHash: hash("D") }),
      ],
    });
    const external = parsed.contracts.find(
      (resource): resource is ExternalContractResource => resource.kind === "external",
    );

    expect(external).toEqual({
      kind: "external",
      id: "registry",
      address: address("a"),
      expectedRuntimeCodeHash: hash("d"),
    });
    expect(Object.isFrozen(external)).toBe(true);
    expect(Object.keys(external ?? {})).toEqual([
      "kind",
      "id",
      "address",
      "expectedRuntimeCodeHash",
    ]);
  });

  it("rejects cross-kind aliases of one canonical deployment target", () => {
    const managed = firstContract(manifest());
    const target = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: managed.deployment.salt,
      bytecodeHash: keccak256(managed.deployment.initCode),
    });
    const external = externalResource({ address: target });

    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v1",
          contracts: [managed, external],
        }),
      "duplicate_resource",
      "manifest.contracts[1].address",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v1",
          contracts: [external, managed],
        }),
      "duplicate_resource",
      "manifest.contracts[1].deployment",
    );
  });

  it("requires the exact current resource discriminant", () => {
    const missingKind = structuredClone(manifest()) as unknown as {
      contracts: [Record<string, unknown>];
    };
    delete missingKind.contracts[0].kind;
    expectManifestError(() => parseManifest(missingKind as never), "invalid_resource");

    const { kind: _kind, ...managedWithoutKind } = firstContract(manifest());
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v1",
          contracts: [{ ...managedWithoutKind, external: true }],
        } as never),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v1",
          contracts: [{ ...externalResource(), kind: "EXTERNAL" }],
        } as never),
      "invalid_resource",
    );
  });

  it("rejects every writable or compatibility field on external resources", () => {
    for (const [field, value] of [
      ["deployment", firstContract(manifest()).deployment],
      ["configuration", []],
      ["sender", { kind: "owner-eoa", address: address("b") }],
      [
        "enforcement",
        { callScope: "required-onchain", expiry: "required", operationLimit: "required" },
      ],
      ["checks", []],
      ["storage", []],
      ["storageChecks", []],
    ] as const) {
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v1",
            contracts: [{ ...externalResource(), [field]: value }],
          }),
        "unknown_field",
      );
    }
  });

  it("requires normalized nonzero exact external addresses and nonempty runtime hashes", () => {
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v1",
          contracts: [externalResource({ address: address("0") })],
        }),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v1",
          contracts: [externalResource({ address: "0x1234" as never })],
        }),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v1",
          contracts: [externalResource({ expectedRuntimeCodeHash: keccak256("0x") })],
        }),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v1",
          contracts: [externalResource(), externalResource({ id: "other" })],
        }),
      "duplicate_resource",
    );
  });

  it("derives one identity from mixed resource order", () => {
    const managed = firstContract(manifest());
    const external = externalResource({ id: "admin-registry" });
    const left: MoesiManifest = {
      version: "moesi.manifest/v1",
      contracts: [managed, external],
    };
    const right: MoesiManifest = {
      version: "moesi.manifest/v1",
      contracts: [external, managed],
    };

    expect(parseManifest(left).manifestHash).toBe(parseManifest(right).manifestHash);
    expect(parseManifest(left).contracts.map(({ id }) => id)).toEqual([
      "admin-registry",
      "counter",
    ]);
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
    expect(firstContract(parseManifest(configured)).configuration.map(({ id }) => id)).toEqual([
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
    expect(firstContract(parsed).sender).toEqual({
      kind: "owner-eoa",
      address: address("e"),
    });
    expect(Object.isFrozen(firstContract(parsed).sender)).toBe(true);
  });

  it("parses an optional smart-account sender", () => {
    const withSender = structuredClone(manifest()) as Mutable<MoesiManifest>;
    mutableFirstContract(withSender).sender = {
      kind: "smart-account",
      accountId: "kernel:main",
    };

    expect(firstContract(parseManifest(withSender)).sender).toEqual({
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
    expect(firstContract(parseManifest(enforced)).enforcement).toEqual({
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
    expect(firstContract(plain).sender).toBeUndefined();
    expect(firstContract(plain).enforcement).toBeUndefined();
  });
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
