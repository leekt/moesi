import { getCreate2Address, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type {
  ContractResource,
  Create2FactoryDeployment,
  ReadOnlyCallCheck,
  ResolvedMoesiManifest,
  StorageWordCheck,
} from "../src/index.js";
import { CREATE2_FACTORY_V1_ADDRESS, MoesiManifestError, parseManifest } from "../src/index.js";
import { deriveManagedDeploymentOrder } from "../src/manifest/runtime-prerequisites.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;

type ManagedContractResource = Extract<ContractResource, { readonly kind: "managed" }>;
type Create2ManagedContractResource = Omit<ManagedContractResource, "deployment"> & {
  readonly deployment: Create2FactoryDeployment;
};
type ExternalContractResource = Extract<ContractResource, { readonly kind: "external" }>;
type ManagedManifest = Omit<ResolvedMoesiManifest, "contracts"> & {
  readonly contracts: readonly Create2ManagedContractResource[];
};

function manifest(): ManagedManifest {
  return {
    version: "moesi.manifest/v8",
    contracts: [
      {
        kind: "managed",
        semanticChecks: [],
        id: "counter",
        deployment: {
          kind: "create2-factory-v1",
          salt: hash("B"),
          initCode: "0x60006000",
          value: "0",
          requiresRuntime: [],
        },
        expectedRuntimeCodeHash: keccak256("0x6000"),
        configuration: [],
        checks: [],
        storageChecks: [],
      },
    ],
  };
}

function externalResource(input: Partial<ExternalContractResource> = {}): ExternalContractResource {
  return {
    kind: "external",
    semanticChecks: [],
    id: "registry",
    address: address("A"),
    expectedRuntimeCodeHash: hash("D"),
    checks: [],
    storageChecks: [],
    ...input,
  };
}

function readOnlyCallCheck(input: Partial<ReadOnlyCallCheck> = {}): ReadOnlyCallCheck {
  return {
    id: "owner",
    caller: address("B"),
    readData: "0xAABBCCDD",
    expectedResult: "0x01",
    ...input,
  };
}

function storageWordCheck(input: Partial<StorageWordCheck> = {}): StorageWordCheck {
  return {
    id: "implementation",
    slot: hash("A"),
    expectedWord: hash("B"),
    ...input,
  };
}

function managedResource(
  id: string,
  saltByte: string,
  requiresRuntime: readonly string[] = [],
): Create2ManagedContractResource {
  const resource = firstContract(manifest());
  return {
    ...resource,
    id,
    deployment: {
      ...resource.deployment,
      salt: hash(saltByte),
      requiresRuntime,
    },
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

function firstContract(value: ResolvedMoesiManifest): Create2ManagedContractResource {
  const contract = value.contracts[0];
  if (!contract) throw new Error("missing test contract");
  if (contract.kind !== "managed") throw new Error("expected managed test contract");
  if (contract.deployment.kind !== "create2-factory-v1") {
    throw new Error("expected CREATE2 factory test deployment");
  }
  return contract as Create2ManagedContractResource;
}

function mutableFirstContract(
  value: Mutable<ResolvedMoesiManifest>,
): Mutable<ManagedContractResource> {
  const contract = value.contracts[0];
  if (!contract) throw new Error("missing mutable test contract");
  if (contract.kind !== "managed") throw new Error("expected mutable managed test contract");
  return contract;
}

describe("parseManifest", () => {
  it("normalizes and freezes the single current manifest contract", () => {
    const parsed = parseManifest(manifest());
    const managed = firstContract(parsed);

    expect(parsed.version).toBe("moesi.manifest/v8");
    expect(managed.kind).toBe("managed");
    expect(managed.deployment.salt).toBe(hash("b"));
    expect(managed.deployment.requiresRuntime).toEqual([]);
    expect(parsed.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(managed.deployment)).toBe(true);
    expect(Object.isFrozen(managed.deployment.requiresRuntime)).toBe(true);
    expect(Object.isFrozen(managed.checks)).toBe(true);
    expect(Object.isFrozen(managed.storageChecks)).toBe(true);
    expect(Object.keys(managed)).toEqual([
      "kind",
      "id",
      "deployment",
      "semanticChecks",
      "expectedRuntimeCodeHash",
      "configuration",
      "checks",
      "storageChecks",
    ]);
  });

  it("canonicalizes, freezes, and hashes managed read-only attestations", () => {
    const zetaCall = readOnlyCallCheck({
      id: "zeta",
      caller: address("B"),
      readData: "0xAABBCCDD",
      expectedResult: "0xCAFE",
    });
    const alphaCall = readOnlyCallCheck({
      id: "alpha",
      caller: address("C"),
      readData: "0x11223344FF",
      expectedResult: "0x00",
    });
    const zetaStorage = storageWordCheck({
      id: "zeta",
      slot: hash("0"),
      expectedWord: hash("0"),
    });
    const alphaStorage = storageWordCheck({
      id: "alpha",
      slot: hash("C"),
      expectedWord: hash("D"),
    });
    const base = firstContract(manifest());
    const left: ResolvedMoesiManifest = {
      version: "moesi.manifest/v8",
      contracts: [
        {
          ...base,
          checks: [zetaCall, alphaCall],
          storageChecks: [zetaStorage, alphaStorage],
        },
      ],
    };
    const right: ResolvedMoesiManifest = {
      version: "moesi.manifest/v8",
      contracts: [
        {
          ...base,
          checks: [alphaCall, zetaCall],
          storageChecks: [alphaStorage, zetaStorage],
        },
      ],
    };

    const parsed = parseManifest(left);
    const managed = firstContract(parsed);
    expect(managed.configuration).toEqual([]);
    expect(managed.checks).toEqual([
      {
        id: "alpha",
        caller: address("c"),
        readData: "0x11223344ff",
        expectedResult: "0x00",
      },
      {
        id: "zeta",
        caller: address("b"),
        readData: "0xaabbccdd",
        expectedResult: "0xcafe",
      },
    ]);
    expect(managed.storageChecks).toEqual([
      { id: "alpha", slot: hash("c"), expectedWord: hash("d") },
      { id: "zeta", slot: hash("0"), expectedWord: hash("0") },
    ]);
    expect(parsed.manifestHash).toBe(parseManifest(right).manifestHash);
    expect(parsed.manifestHash).not.toBe(parseManifest(manifest()).manifestHash);
    expect(Object.isFrozen(managed.checks)).toBe(true);
    expect(Object.isFrozen(managed.checks[0])).toBe(true);
    expect(Object.isFrozen(managed.storageChecks)).toBe(true);
    expect(Object.isFrozen(managed.storageChecks[0])).toBe(true);
  });

  it("canonicalizes exact runtime prerequisites and derives deterministic deployment order", () => {
    const application = managedResource("application", "1", ["zeta-library", "registry"]);
    const auxiliary = managedResource("auxiliary", "2");
    const library = managedResource("zeta-library", "3");
    const registry = externalResource({ id: "registry" });
    const left: ResolvedMoesiManifest = {
      version: "moesi.manifest/v8",
      contracts: [application, registry, library, auxiliary],
    };
    const right: ResolvedMoesiManifest = {
      version: "moesi.manifest/v8",
      contracts: [
        auxiliary,
        library,
        registry,
        {
          ...application,
          deployment: {
            ...application.deployment,
            requiresRuntime: ["registry", "zeta-library"],
          },
        },
      ],
    };

    const parsed = parseManifest(left);
    const parsedApplication = parsed.contracts.find(({ id }) => id === "application");
    if (parsedApplication?.kind !== "managed") throw new Error("missing application");
    expect(parsedApplication.deployment.requiresRuntime).toEqual(["registry", "zeta-library"]);
    expect(Object.isFrozen(parsedApplication.deployment.requiresRuntime)).toBe(true);
    expect(parsed.manifestHash).toBe(parseManifest(right).manifestHash);
    const order = deriveManagedDeploymentOrder(parsed.contracts);
    expect(order).toEqual(["auxiliary", "zeta-library", "application"]);
    expect(Object.isFrozen(order)).toBe(true);
  });

  it("binds runtime prerequisite edges into manifest identity", () => {
    const dependency = managedResource("dependency", "1");
    const withoutEdge: ResolvedMoesiManifest = {
      version: "moesi.manifest/v8",
      contracts: [managedResource("application", "2"), dependency],
    };
    const withEdge: ResolvedMoesiManifest = {
      version: "moesi.manifest/v8",
      contracts: [managedResource("application", "2", ["dependency"]), dependency],
    };

    expect(parseManifest(withEdge).manifestHash).not.toBe(parseManifest(withoutEdge).manifestHash);
  });

  it("requires a dense array of unique exact runtime prerequisite resource ids", () => {
    const missing = structuredClone(manifest()) as unknown as {
      contracts: [{ deployment: Record<string, unknown> }];
    };
    delete missing.contracts[0].deployment.requiresRuntime;
    for (const value of [
      undefined,
      null,
      {},
      new Array(1),
      [1],
      ["invalid:id"],
      ["dependency", "dependency"],
    ]) {
      const source = structuredClone(manifest()) as unknown as {
        contracts: [{ deployment: Record<string, unknown> }];
      };
      source.contracts[0].deployment.requiresRuntime = value;
      expectManifestError(() => parseManifest(source as never), "invalid_deployment");
    }
    expectManifestError(() => parseManifest(missing as never), "invalid_deployment");
  });

  it("rejects unknown, self-referential, and cyclic runtime prerequisites", () => {
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [managedResource("application", "1", ["missing"])],
        }),
      "invalid_deployment",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [managedResource("application", "1", ["application"])],
        }),
      "invalid_deployment",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [
            managedResource("alpha", "1", ["bravo"]),
            managedResource("bravo", "2", ["charlie"]),
            managedResource("charlie", "3", ["alpha"]),
          ],
        }),
      "invalid_deployment",
    );
  });

  it("normalizes and freezes exact-address external resources", () => {
    const parsed = parseManifest({
      version: "moesi.manifest/v8",
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
      semanticChecks: [],
      id: "registry",
      address: address("a"),
      expectedRuntimeCodeHash: hash("d"),
      checks: [],
      storageChecks: [],
    });
    expect(Object.isFrozen(external)).toBe(true);
    expect(Object.keys(external ?? {})).toEqual([
      "kind",
      "id",
      "address",
      "semanticChecks",
      "expectedRuntimeCodeHash",
      "checks",
      "storageChecks",
    ]);
  });

  it("canonicalizes, freezes, and hashes external checks by semantic id order", () => {
    const zeta = {
      id: "zeta",
      caller: address("B"),
      readData: "0xAABBCCDD" as const,
      expectedResult: "0xCAFE" as const,
    };
    const alpha = {
      id: "alpha",
      caller: address("C"),
      readData: "0x11223344FF" as const,
      expectedResult: "0x00" as const,
    };
    const left = parseManifest({
      version: "moesi.manifest/v8",
      contracts: [externalResource({ checks: [zeta, alpha] })],
    });
    const right = parseManifest({
      version: "moesi.manifest/v8",
      contracts: [externalResource({ checks: [alpha, zeta] })],
    });
    const external = left.contracts[0];
    if (external?.kind !== "external") throw new Error("missing external check fixture");

    expect(external.checks).toEqual([
      {
        id: "alpha",
        caller: address("c"),
        readData: "0x11223344ff",
        expectedResult: "0x00",
      },
      {
        id: "zeta",
        caller: address("b"),
        readData: "0xaabbccdd",
        expectedResult: "0xcafe",
      },
    ]);
    expect(left.manifestHash).toBe(right.manifestHash);
    expect(left.manifestHash).not.toBe(
      parseManifest({
        version: "moesi.manifest/v8",
        contracts: [
          externalResource({
            checks: [{ ...alpha, expectedResult: "0x01" }, zeta],
          }),
        ],
      }).manifestHash,
    );
    expect(Object.isFrozen(external.checks)).toBe(true);
    expect(Object.isFrozen(external.checks[0])).toBe(true);
  });

  it("requires a dense external checks array while allowing it to be empty", () => {
    expect(
      parseManifest({
        version: "moesi.manifest/v8",
        contracts: [externalResource()],
      }).contracts[0],
    ).toMatchObject({ checks: [] });

    const missing = structuredClone(externalResource()) as unknown as Record<string, unknown>;
    delete missing.checks;
    for (const checks of [undefined, null, {}, new Array(1)]) {
      const resource = checks === undefined ? missing : { ...externalResource(), checks };
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v8",
            contracts: [resource],
          } as never),
        "invalid_resource",
      );
    }
  });

  it("canonicalizes, freezes, and hashes external storage checks by semantic id order", () => {
    const zeta = storageWordCheck({
      id: "zeta",
      slot: hash("C"),
      expectedWord: hash("D"),
    });
    const alpha = storageWordCheck({
      id: "alpha",
      slot: hash("A"),
      expectedWord: hash("B"),
    });
    const left = parseManifest({
      version: "moesi.manifest/v8",
      contracts: [externalResource({ storageChecks: [zeta, alpha] })],
    });
    const right = parseManifest({
      version: "moesi.manifest/v8",
      contracts: [externalResource({ storageChecks: [alpha, zeta] })],
    });
    const external = left.contracts[0];
    if (external?.kind !== "external") throw new Error("missing external storage fixture");

    expect(external.storageChecks).toEqual([
      { id: "alpha", slot: hash("a"), expectedWord: hash("b") },
      { id: "zeta", slot: hash("c"), expectedWord: hash("d") },
    ]);
    expect(left.manifestHash).toBe(right.manifestHash);
    expect(left.manifestHash).not.toBe(
      parseManifest({
        version: "moesi.manifest/v8",
        contracts: [
          externalResource({
            storageChecks: [{ ...alpha, expectedWord: hash("e") }, zeta],
          }),
        ],
      }).manifestHash,
    );
    expect(Object.isFrozen(external.storageChecks)).toBe(true);
    expect(Object.isFrozen(external.storageChecks[0])).toBe(true);
  });

  it("requires a dense external storageChecks array while allowing it to be empty", () => {
    expect(
      parseManifest({
        version: "moesi.manifest/v8",
        contracts: [externalResource()],
      }).contracts[0],
    ).toMatchObject({ storageChecks: [] });

    const missing = structuredClone(externalResource()) as unknown as Record<string, unknown>;
    delete missing.storageChecks;
    for (const storageChecks of [undefined, null, {}, new Array(1)]) {
      const resource =
        storageChecks === undefined ? missing : { ...externalResource(), storageChecks };
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v8",
            contracts: [resource],
          } as never),
        "invalid_resource",
      );
    }
  });

  it("rejects malformed, duplicate, or non-exact external storage checks", () => {
    const valid = storageWordCheck();
    for (const check of [
      { ...valid, id: "" },
      { ...valid, id: "invalid:check" },
      { ...valid, slot: "0x00" },
      { ...valid, expectedWord: "0x00" },
      null,
      [],
      new Date(0),
    ]) {
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v8",
            contracts: [externalResource({ storageChecks: [check] as never })],
          }),
        "invalid_resource",
      );
    }

    for (const field of ["id", "slot", "expectedWord"] as const) {
      const incomplete = { ...valid } as Record<string, unknown>;
      delete incomplete[field];
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v8",
            contracts: [externalResource({ storageChecks: [incomplete] as never })],
          }),
        "invalid_resource",
      );
    }

    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [
            externalResource({
              storageChecks: [valid, storageWordCheck({ slot: hash("c") })],
            }),
          ],
        }),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [
            externalResource({
              storageChecks: [
                storageWordCheck({ id: "alpha", slot: hash("A") }),
                storageWordCheck({ id: "zeta", slot: hash("a") }),
              ],
            }),
          ],
        }),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [
            externalResource({
              storageChecks: [{ ...valid, alias: "eip1967.proxy.implementation" } as never],
            }),
          ],
        }),
      "unknown_field",
    );
  });

  it("rejects malformed, duplicate, or non-exact external checks", () => {
    const valid: ReadOnlyCallCheck = {
      id: "owner",
      caller: address("B"),
      readData: "0xAABBCCDD" as const,
      expectedResult: "0x01" as const,
    };
    for (const check of [
      { ...valid, id: "" },
      { ...valid, caller: "0x1234" },
      { ...valid, caller: address("0") },
      { ...valid, readData: "0xAABBCC" },
      { ...valid, expectedResult: "0x" },
      { ...valid, expectedResult: "0x1" },
    ]) {
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v8",
            contracts: [externalResource({ checks: [check] as never })],
          }),
        "invalid_resource",
      );
    }
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [externalResource({ checks: [valid, valid] })],
        }),
      "invalid_resource",
    );

    for (const [field, value] of [
      ["abi", []],
      ["target", address("d")],
      ["value", "0"],
      ["storage", []],
    ] as const) {
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v8",
            contracts: [externalResource({ checks: [{ ...valid, [field]: value }] })],
          }),
        "unknown_field",
      );
    }
  });

  it("requires dense checks and storageChecks arrays on managed resources", () => {
    for (const field of ["checks", "storageChecks"] as const) {
      const missing = structuredClone(firstContract(manifest())) as unknown as Record<
        string,
        unknown
      >;
      delete missing[field];
      for (const value of [undefined, null, {}, new Array(1)]) {
        const resource =
          value === undefined ? missing : { ...firstContract(manifest()), [field]: value };
        expectManifestError(
          () =>
            parseManifest({
              version: "moesi.manifest/v8",
              contracts: [resource],
            } as never),
          "invalid_resource",
        );
      }
    }
  });

  it("applies exact literal attestation validation to managed resources", () => {
    const managed = firstContract(manifest());
    for (const check of [
      readOnlyCallCheck({ caller: address("0") }),
      readOnlyCallCheck({ readData: "0x010203" }),
      readOnlyCallCheck({ expectedResult: "0x" }),
    ]) {
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v8",
            contracts: [{ ...managed, checks: [check] }],
          }),
        "invalid_resource",
      );
    }
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [
            {
              ...managed,
              checks: [readOnlyCallCheck(), readOnlyCallCheck({ caller: address("c") })],
            },
          ],
        }),
      "invalid_resource",
    );

    for (const check of [
      storageWordCheck({ slot: "0x00" }),
      storageWordCheck({ expectedWord: "0x00" }),
    ]) {
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v8",
            contracts: [{ ...managed, storageChecks: [check] }],
          }),
        "invalid_resource",
      );
    }
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [
            {
              ...managed,
              storageChecks: [
                storageWordCheck({ id: "alpha", slot: hash("A") }),
                storageWordCheck({ id: "zeta", slot: hash("a") }),
              ],
            },
          ],
        }),
      "invalid_resource",
    );
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
          version: "moesi.manifest/v8",
          contracts: [managed, external],
        }),
      "duplicate_resource",
      "manifest.contracts[1].address",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
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
          version: "moesi.manifest/v8",
          contracts: [{ ...managedWithoutKind, external: true }],
        } as never),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
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
      ["storage", []],
    ] as const) {
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v8",
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
          version: "moesi.manifest/v8",
          contracts: [externalResource({ address: address("0") })],
        }),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [externalResource({ address: "0x1234" as never })],
        }),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [externalResource({ expectedRuntimeCodeHash: keccak256("0x") })],
        }),
      "invalid_resource",
    );
    expectManifestError(
      () =>
        parseManifest({
          version: "moesi.manifest/v8",
          contracts: [externalResource(), externalResource({ id: "other" })],
        }),
      "duplicate_resource",
    );
  });

  it("derives one identity from mixed resource order", () => {
    const managed = firstContract(manifest());
    const external = externalResource({ id: "admin-registry" });
    const left: ResolvedMoesiManifest = {
      version: "moesi.manifest/v8",
      contracts: [managed, external],
    };
    const right: ResolvedMoesiManifest = {
      version: "moesi.manifest/v8",
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

    const ambiguousId = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
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

    const genericDependency = structuredClone(manifest()) as unknown as {
      contracts: Array<{ deployment: Record<string, unknown> }>;
    };
    const genericDeployment = genericDependency.contracts[0]?.deployment;
    if (!genericDeployment) throw new Error("missing generic deployment fixture");
    genericDeployment.dependsOn = [];
    expectManifestError(() => parseManifest(genericDependency as never), "unknown_field");

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
          version: "moesi.manifest/v8",
          contracts: new Array(1),
        } as never),
      "invalid_manifest",
    );

    const sparseConfiguration = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(sparseConfiguration).configuration = new Array(1);
    expectManifestError(() => parseManifest(sparseConfiguration), "invalid_resource");
  });

  it("does not dispatch through caller-owned array methods", () => {
    const valid = firstContract(manifest());
    const contracts = [{ ...valid, id: "invalid:resource" }];
    Object.defineProperty(contracts, "map", { value: () => [valid] });

    expectManifestError(
      () => parseManifest({ version: "moesi.manifest/v8", contracts } as ResolvedMoesiManifest),
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
    const source = Object.defineProperty({ version: "moesi.manifest/v8" }, "contracts", {
      enumerable: true,
      get() {
        contractsReads += 1;
        return contractsReads === 1 ? contracts : [];
      },
    });

    expect(parseManifest(source as ResolvedMoesiManifest).contracts).toHaveLength(1);
    expect(contractsReads).toBe(1);
    expect(lengthReads).toBe(1);
  });

  it("rejects empty init code and non-canonical deployment values", () => {
    const empty = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(empty).deployment.initCode = "0x";
    expectManifestError(() => parseManifest(empty), "invalid_deployment");

    const negative = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(negative).deployment.value = "-1";
    expectManifestError(() => parseManifest(negative), "invalid_deployment");

    const leadingZero = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(leadingZero).deployment.value = "01";
    expectManifestError(() => parseManifest(leadingZero), "invalid_deployment");
  });

  it("rejects the empty runtime-code hash", () => {
    const emptyRuntime = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(emptyRuntime).expectedRuntimeCodeHash = keccak256("0x");
    expectManifestError(() => parseManifest(emptyRuntime), "invalid_resource");
  });

  it("preserves configuration declaration order and rejects malformed rules", () => {
    const configured = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
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
      "zeta",
      "alpha",
    ]);

    const firstRule = mutableFirstContract(configured).configuration[0];
    if (!firstRule) throw new Error("missing test configuration");
    firstRule.readData = "0x01";
    expectManifestError(() => parseManifest(configured), "invalid_resource");
  });

  it("parses and freezes an optional owner EOA sender", () => {
    const withSender = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(withSender).sender = { kind: "owner-eoa", address: address("E") };

    const parsed = parseManifest(withSender);
    expect(firstContract(parsed).sender).toEqual({
      kind: "owner-eoa",
      address: address("e"),
    });
    expect(Object.isFrozen(firstContract(parsed).sender)).toBe(true);
  });

  it("parses an optional smart-account sender", () => {
    const withSender = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(withSender).sender = {
      kind: "smart-account",
      accountId: "kernel:main",
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    expect(firstContract(parseManifest(withSender)).sender).toEqual({
      kind: "smart-account",
      accountId: "kernel:main",
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("rejects malformed sender declarations", () => {
    const badAddress = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(badAddress).sender = { kind: "owner-eoa", address: "0x1234" as never };
    expectManifestError(() => parseManifest(badAddress), "invalid_sender");

    const badAccount = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(badAccount).sender = {
      kind: "smart-account",
      accountId: "",
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    expectManifestError(() => parseManifest(badAccount), "invalid_sender");

    const unknownKind = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(unknownKind).sender = { kind: "any" } as never;
    expectManifestError(() => parseManifest(unknownKind), "invalid_sender");

    const extraField = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(extraField).sender = {
      kind: "owner-eoa",
      address: address("E"),
      note: "x",
    } as never;
    expectManifestError(() => parseManifest(extraField), "unknown_field");
  });

  it("parses explicit enforcement and rejects partial declarations", () => {
    const enforced = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
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

    const partial = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
    mutableFirstContract(partial).enforcement = { callScope: "required-onchain" } as never;
    expectManifestError(() => parseManifest(partial), "invalid_enforcement");

    const invalid = structuredClone(manifest()) as Mutable<ResolvedMoesiManifest>;
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
