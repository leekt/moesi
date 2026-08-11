import { concatHex, encodeAbiParameters, getCreate2Address, type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type {
  CallReadRequest,
  CodeReadRequest,
  Create2FactoryDeployment,
  ManagedContractResource,
  MoesiManifest,
  MoesiObservationAdapter,
  ReadOnlyCallCheck,
  SnapshotReference,
  StorageReadRequest,
  StorageWordCheck,
} from "../src/index.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
  createMoesi,
  MoesiPlanError,
  type MoesiPlanningError,
} from "../src/index.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const RUNTIME_CODE = "0x6000" as const;
const OTHER_CODE = "0x6001" as const;
const CREATE2_FACTORY_V1_RUNTIME_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as const;

type ManagedManifest = Omit<MoesiManifest, "contracts"> & {
  readonly contracts: readonly Create2ManagedContractResource[];
};

type Create2ManagedContractResource = Omit<ManagedContractResource, "deployment"> & {
  readonly deployment: Create2FactoryDeployment;
};

function manifest(): ManagedManifest {
  return {
    version: "moesi.manifest/v2",
    contracts: [
      {
        kind: "managed",
        id: "counter",
        deployment: {
          kind: "create2-factory-v1",
          salt: hash("b"),
          initCode: "0x60006000",
          value: "7",
          requiresRuntime: [],
        },
        expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
        configuration: [],
        checks: [],
        storageChecks: [],
      },
    ],
  };
}

function firstContract(): Create2ManagedContractResource {
  const contract = manifest().contracts[0];
  if (!contract) throw new Error("missing test contract");
  return contract;
}

function externalManifest(
  checks: readonly ReadOnlyCallCheck[] = [],
  storageChecks: readonly StorageWordCheck[] = [],
): MoesiManifest {
  return {
    version: "moesi.manifest/v2",
    contracts: [
      {
        kind: "external",
        id: "canonical-infrastructure",
        address: address("A"),
        expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
        checks,
        storageChecks,
      },
    ],
  };
}

function observer(
  codeByChain: ReadonlyMap<number, unknown>,
  capabilityCodeByChain: ReadonlyMap<number, unknown> = new Map(),
): {
  adapter: MoesiObservationAdapter;
  reads: CodeReadRequest[];
} {
  const reads: CodeReadRequest[] = [];
  return {
    reads,
    adapter: {
      async captureSnapshot(chainId): Promise<SnapshotReference> {
        return {
          blockNumber: BigInt(chainId * 100).toString(10),
          blockHash: hash(chainId === 1 ? "1" : "2"),
        };
      },
      async readCode(request): Promise<unknown> {
        reads.push(request);
        const value =
          request.address === CREATE2_FACTORY_V1_ADDRESS
            ? (capabilityCodeByChain.get(request.chainId) ?? CREATE2_FACTORY_V1_RUNTIME_CODE)
            : codeByChain.get(request.chainId);
        if (value instanceof Error) throw value;
        return value;
      },
      async readCall(): Promise<Hex> {
        return "0x";
      },
      async checkBlockAncestry(): Promise<boolean> {
        return true;
      },
    },
  };
}

describe("Moesi planner", () => {
  it("rejects cross-kind target aliases before snapshot or RPC observation", async () => {
    const managed = firstContract();
    const target = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: managed.deployment.salt,
      bytecodeHash: keccak256(managed.deployment.initCode),
    });
    const observed = observer(new Map([[1, RUNTIME_CODE]]));
    let snapshots = 0;
    const client = createMoesi({
      observer: {
        ...observed.adapter,
        async captureSnapshot(chainId) {
          snapshots += 1;
          return observed.adapter.captureSnapshot(chainId);
        },
      },
    });

    await expect(
      client.plan({
        chains: [1],
        manifest: {
          version: "moesi.manifest/v2",
          contracts: [
            managed,
            {
              kind: "external",
              id: "managed-alias",
              address: target,
              expectedRuntimeCodeHash: managed.expectedRuntimeCodeHash,
              checks: [],
              storageChecks: [],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "duplicate_resource",
      path: "manifest.contracts[1].address",
    });
    expect(snapshots).toBe(0);
    expect(observed.reads).toEqual([]);
  });

  it("observes pinned state and compiles deterministic CREATE2 deployment calls", async () => {
    const observed = observer(
      new Map<number, unknown>([
        [1, "0x"],
        [10, "0x"],
      ]),
    );
    const moesi = createMoesi({ observer: observed.adapter });
    const plan = await moesi.plan({ manifest: manifest(), chains: [10, 1] });
    const expectedAddress = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: hash("b"),
      bytecodeHash: keccak256("0x60006000"),
    });

    expect(plan.disposition).toBe("changes");
    expect(plan.snapshots.map(({ chainId }) => chainId)).toEqual([1, 10]);
    expect(plan.cells.map(({ chainId, address: cellAddress }) => [chainId, cellAddress])).toEqual([
      [1, expectedAddress.toLowerCase()],
      [10, expectedAddress.toLowerCase()],
    ]);
    expect(plan.steps.map(({ chainId }) => chainId)).toEqual([1, 10]);
    expect(plan.steps[0]?.call.target).toBe(CREATE2_FACTORY_V1_ADDRESS);
    expect(plan.steps[0]?.call.value).toBe("7");
    expect(plan.steps[0]?.call.data).toBe(concatHex([hash("b"), "0x60006000"]));
    expect(plan.steps[0]?.sender).toBeNull();
    expect(plan.steps[0]?.enforcement).toEqual({
      callScope: "interactive-review-sufficient",
      expiry: "optional",
      operationLimit: "optional",
    });
    expect(plan.requirements.map(({ chainId }) => chainId)).toEqual([1, 10]);
    expect(plan.requirements[0]?.sender).toEqual({ kind: "sender-independent" });
    expect(plan.requirements[0]?.calls).toHaveLength(1);
    expect(plan.requirements[0]?.postconditions).toHaveLength(1);
    expect(observed.reads[0]?.snapshot).toEqual(plan.snapshots[0]);
    expect(plan.capabilities).toEqual([
      {
        kind: "create2-factory-v1",
        chainId: 1,
        address: CREATE2_FACTORY_V1_ADDRESS,
        expectedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
        status: {
          kind: "available",
          observedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
        },
      },
      {
        kind: "create2-factory-v1",
        chainId: 10,
        address: CREATE2_FACTORY_V1_ADDRESS,
        expectedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
        status: {
          kind: "available",
          observedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
        },
      },
    ]);

    const samePlan = await moesi.plan({ manifest: manifest(), chains: [1, 10] });
    expect(samePlan.planId).toBe(plan.planId);
  });

  it("observes one pinned canonical factory capability for all missing work on a chain", async () => {
    const first = firstContract();
    const desired: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [
        first,
        { ...first, id: "admin", deployment: { ...first.deployment, salt: hash("c") } },
      ],
    };
    const observed = observer(new Map([[1, "0x"]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: desired,
      chains: [1],
    });

    expect(
      observed.reads.filter(
        ({ address: observedAddress }) => observedAddress === CREATE2_FACTORY_V1_ADDRESS,
      ),
    ).toEqual([
      {
        chainId: 1,
        address: CREATE2_FACTORY_V1_ADDRESS,
        snapshot: plan.snapshots[0],
      },
    ]);
    expect(plan.capabilities).toHaveLength(1);
    expect(plan.steps.filter(({ kind }) => kind === "deploy")).toHaveLength(2);
  });

  it.each([
    ["missing", "0x", { kind: "missing" }],
    [
      "bytecode drift",
      OTHER_CODE,
      { kind: "bytecode-drift", observedRuntimeCodeHash: keccak256(OTHER_CODE) },
    ],
    [
      "unreadable",
      new Error("secret factory response"),
      { kind: "unreadable", reason: "read-failed" },
    ],
    ["invalid response", "not-hex", { kind: "unreadable", reason: "invalid-response" }],
  ] as const)("blocks missing deployment work when the factory is %s", async (_, code, status) => {
    const observed = observer(new Map([[1, "0x"]]), new Map([[1, code]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: manifest(),
      chains: [1],
    });

    expect(plan.disposition).toBe("blocked");
    expect(plan.capabilities[0]?.status).toEqual(status);
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain("secret factory response");
  });

  it("keeps existing configuration drift actionable when missing work is capability-blocked", async () => {
    const first = firstContract();
    const configured = {
      ...first,
      id: "configured",
      configuration: [
        {
          id: "value",
          readData: "0x11111111" as const,
          expectedResult: "0x01" as const,
          writeData: "0x22222222" as const,
          value: "0",
        },
      ],
    };
    const missing = {
      ...first,
      id: "missing",
      deployment: { ...first.deployment, salt: hash("c") },
    };
    const desired: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [configured, missing],
    };
    const configuredAddress = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: configured.deployment.salt,
      bytecodeHash: keccak256(configured.deployment.initCode),
    }).toLowerCase();
    const base = observer(new Map([[1, "0x"]]), new Map([[1, "0x"]]));
    const plan = await createMoesi({
      observer: {
        ...base.adapter,
        async readCode(request): Promise<unknown> {
          if (request.address === configuredAddress) return RUNTIME_CODE;
          return base.adapter.readCode(request);
        },
        async readCall(): Promise<Hex> {
          return "0x00";
        },
      },
    }).plan({ manifest: desired, chains: [1] });

    expect(plan.disposition).toBe("partial");
    expect(plan.capabilities[0]?.status).toEqual({ kind: "missing" });
    expect(plan.steps.map(({ id, kind }) => [id, kind])).toEqual([
      ["configured:configure:value", "configure"],
    ]);
    expect(plan.requirements[0]?.calls).toEqual([plan.steps[0]?.call]);
  });

  it("returns converged evidence without calls when runtime bytecode matches", async () => {
    const observed = observer(new Map([[1, RUNTIME_CODE]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: manifest(),
      chains: [1],
    });

    expect(plan.disposition).toBe("converged");
    expect(plan.cells[0]?.storageChecks).toEqual([]);
    expect(plan.cells[0]?.status).toEqual({
      kind: "converged",
      observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      configurationResults: [],
      callResults: [],
      storageResults: [],
    });
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
  });

  it("observes a converged external resource at its exact address without factory evidence", async () => {
    const observed = observer(new Map([[1, RUNTIME_CODE]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: externalManifest(),
      chains: [1],
    });

    expect(plan.disposition).toBe("converged");
    expect(plan.cells).toEqual([
      {
        resourceId: "canonical-infrastructure",
        chainId: 1,
        address: address("a"),
        expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
        configuration: [],
        checks: [],
        storageChecks: [],
        status: {
          kind: "converged",
          observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
          configurationResults: [],
          callResults: [],
          storageResults: [],
        },
      },
    ]);
    expect(plan.capabilities).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
    expect(observed.reads).toEqual([
      { chainId: 1, address: address("a"), snapshot: plan.snapshots[0] },
    ]);
  });

  it("observes external storage then calls in canonical order at one snapshot", async () => {
    const calls: CallReadRequest[] = [];
    const storageReads: StorageReadRequest[] = [];
    const events: string[] = [];
    const desired = externalManifest(
      [
        {
          id: "z-second",
          caller: address("B"),
          readData: "0x22222222",
          expectedResult: "0x02",
        },
        {
          id: "a-first",
          caller: address("C"),
          readData: "0x11111111",
          expectedResult: "0x01",
        },
      ],
      [
        { id: "z-storage", slot: hash("2"), expectedWord: hash("b") },
        { id: "a-storage", slot: hash("1"), expectedWord: hash("a") },
      ],
    );
    const plan = await createMoesi({
      observer: {
        async captureSnapshot() {
          events.push("snapshot");
          return { blockNumber: "100", blockHash: hash("1") };
        },
        async readCode() {
          events.push("runtime");
          return RUNTIME_CODE;
        },
        async readStorage(request) {
          storageReads.push(request);
          events.push(`storage:${request.slot}`);
          return request.slot === hash("1") ? hash("a") : hash("b");
        },
        async readCall(request) {
          calls.push(request);
          events.push(`check:${request.data}`);
          return request.data === "0x11111111" ? "0x01" : "0x02";
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    }).plan({ manifest: desired, chains: [1] });

    expect(events).toEqual([
      "snapshot",
      "runtime",
      `storage:${hash("1")}`,
      `storage:${hash("2")}`,
      "check:0x11111111",
      "check:0x22222222",
    ]);
    expect(storageReads).toEqual([
      {
        chainId: 1,
        address: address("a"),
        slot: hash("1"),
        snapshot: plan.snapshots[0],
      },
      {
        chainId: 1,
        address: address("a"),
        slot: hash("2"),
        snapshot: plan.snapshots[0],
      },
    ]);
    expect(calls).toEqual([
      {
        chainId: 1,
        target: address("a"),
        data: "0x11111111",
        caller: address("c"),
        snapshot: plan.snapshots[0],
      },
      {
        chainId: 1,
        target: address("a"),
        data: "0x22222222",
        caller: address("b"),
        snapshot: plan.snapshots[0],
      },
    ]);
    expect(plan.cells[0]?.configuration).toEqual([]);
    expect(plan.cells[0]?.checks).toEqual([
      { id: "a-first", caller: address("c"), readData: "0x11111111", expectedResult: "0x01" },
      { id: "z-second", caller: address("b"), readData: "0x22222222", expectedResult: "0x02" },
    ]);
    expect(plan.cells[0]?.storageChecks).toEqual([
      { id: "a-storage", slot: hash("1"), expectedWord: hash("a") },
      { id: "z-storage", slot: hash("2"), expectedWord: hash("b") },
    ]);
    expect(plan.cells[0]?.status).toEqual({
      kind: "converged",
      observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      configurationResults: [],
      callResults: [
        { id: "a-first", result: "0x01" },
        { id: "z-second", result: "0x02" },
      ],
      storageResults: [
        { id: "a-storage", word: hash("a") },
        { id: "z-storage", word: hash("b") },
      ],
    });
    expect(plan.capabilities).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
  });

  it("keeps reading after external storage and call drift without creating work", async () => {
    const calls: CallReadRequest[] = [];
    const storageReads: StorageReadRequest[] = [];
    const plan = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "100", blockHash: hash("1") };
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        async readStorage(request) {
          storageReads.push(request);
          return request.slot === hash("1") ? hash("f") : hash("b");
        },
        async readCall(request) {
          calls.push(request);
          return request.data === "0x11111111" ? "0xff" : "0x02";
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    }).plan({
      chains: [1],
      manifest: externalManifest(
        [
          {
            id: "a-drifted",
            caller: address("1"),
            readData: "0x11111111",
            expectedResult: "0x01",
          },
          {
            id: "b-satisfied",
            caller: address("2"),
            readData: "0x22222222",
            expectedResult: "0x02",
          },
        ],
        [
          { id: "a-storage-drifted", slot: hash("1"), expectedWord: hash("a") },
          { id: "b-storage-satisfied", slot: hash("2"), expectedWord: hash("b") },
        ],
      ),
    });

    expect(storageReads.map(({ slot }) => slot)).toEqual([hash("1"), hash("2")]);
    expect(calls.map(({ data }) => data)).toEqual(["0x11111111", "0x22222222"]);
    expect(plan.disposition).toBe("blocked");
    expect(plan.cells[0]?.status).toEqual({
      kind: "drift",
      observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      configurationMismatches: [],
      callMismatches: [
        {
          id: "a-drifted",
          expectedResult: "0x01",
          observedResult: "0xff",
        },
      ],
      storageMismatches: [
        {
          id: "a-storage-drifted",
          expectedWord: hash("a"),
          observedWord: hash("f"),
        },
      ],
    });
    expect(plan.capabilities).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
  });

  it("fails external checks closed at the first unreadable result", async () => {
    const calls: CallReadRequest[] = [];
    const plan = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "100", blockHash: hash("1") };
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        async readCall(request) {
          calls.push(request);
          if (request.data === "0x22222222") {
            throw new Error("credential-bearing external check response");
          }
          return "0x01";
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    }).plan({
      chains: [1],
      manifest: externalManifest([
        {
          id: "a-readable",
          caller: address("1"),
          readData: "0x11111111",
          expectedResult: "0x01",
        },
        {
          id: "b-unreadable",
          caller: address("2"),
          readData: "0x22222222",
          expectedResult: "0x02",
        },
        {
          id: "c-never-read",
          caller: address("3"),
          readData: "0x33333333",
          expectedResult: "0x03",
        },
      ]),
    });

    expect(calls.map(({ data }) => data)).toEqual(["0x11111111", "0x22222222"]);
    expect(plan.disposition).toBe("blocked");
    expect(plan.cells[0]?.status).toEqual({
      kind: "unreadable",
      source: "call-check",
      id: "b-unreadable",
      reason: "read-failed",
      observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
    });
    expect(plan.capabilities).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain("credential-bearing external check response");
  });

  it.each([
    ["unavailable", undefined, "unavailable"],
    [
      "failed",
      async (_request: StorageReadRequest): Promise<unknown> => {
        throw new Error("credential-bearing storage response");
      },
      "read-failed",
    ],
    [
      "invalid",
      async (_request: StorageReadRequest): Promise<unknown> => "0x01",
      "invalid-response",
    ],
  ] as const)(
    "fails external storage %s closed before later storage or calls",
    async (_, readStorage, reason) => {
      const storageReads: StorageReadRequest[] = [];
      const calls: CallReadRequest[] = [];
      const storageReader = readStorage;
      const adapter: MoesiObservationAdapter = {
        async captureSnapshot() {
          return { blockNumber: "100", blockHash: hash("1") };
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        async readCall(request) {
          calls.push(request);
          return "0x01";
        },
        async checkBlockAncestry() {
          return true;
        },
        ...(storageReader === undefined
          ? {}
          : {
              async readStorage(request: StorageReadRequest) {
                storageReads.push(request);
                return storageReader(request);
              },
            }),
      };
      const plan = await createMoesi({ observer: adapter }).plan({
        chains: [1],
        manifest: externalManifest(
          [
            {
              id: "call-never-read",
              caller: address("1"),
              readData: "0x11111111",
              expectedResult: "0x01",
            },
          ],
          [
            { id: "a-first", slot: hash("1"), expectedWord: hash("a") },
            { id: "b-never-read", slot: hash("2"), expectedWord: hash("b") },
          ],
        ),
      });

      expect(storageReads).toHaveLength(storageReader === undefined ? 0 : 1);
      expect(calls).toEqual([]);
      expect(plan.disposition).toBe("blocked");
      expect(plan.cells[0]?.status).toEqual({
        kind: "unreadable",
        source: "storage-check",
        id: "a-first",
        reason,
        observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      });
      expect(plan.capabilities).toEqual([]);
      expect(plan.steps).toEqual([]);
      expect(plan.requirements).toEqual([]);
      expect(JSON.stringify(plan)).not.toContain("credential-bearing storage response");
    },
  );

  it.each([
    ["absent", "0x", { kind: "missing" }],
    [
      "bytecode-drifted",
      OTHER_CODE,
      { kind: "bytecode-drift", observedRuntimeCodeHash: keccak256(OTHER_CODE) },
    ],
    [
      "unreadable",
      new Error("secret external provider response"),
      { kind: "unreadable", source: "runtime-code", id: null, reason: "read-failed" },
    ],
    [
      "invalid",
      "not-hex",
      { kind: "unreadable", source: "runtime-code", id: null, reason: "invalid-response" },
    ],
  ] as const)(
    "blocks an %s external resource without creating actions",
    async (_, code, status) => {
      const observed = observer(new Map([[1, code]]));
      const plan = await createMoesi({ observer: observed.adapter }).plan({
        manifest: externalManifest(),
        chains: [1],
      });

      expect(plan.disposition).toBe("blocked");
      expect(plan.cells[0]?.status).toEqual(status);
      expect(plan.capabilities).toEqual([]);
      expect(plan.steps).toEqual([]);
      expect(plan.requirements).toEqual([]);
      expect(observed.reads.map(({ address: observedAddress }) => observedAddress)).toEqual([
        address("a"),
      ]);
      expect(JSON.stringify(plan)).not.toContain("secret external provider response");
    },
  );

  it("keeps independent managed work actionable when an external resource blocks", async () => {
    const desired: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [...manifest().contracts, ...externalManifest().contracts],
    };
    const observed = observer(new Map([[1, "0x"]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: desired,
      chains: [1],
    });

    expect(plan.disposition).toBe("partial");
    expect(plan.cells.map(({ resourceId, status }) => [resourceId, status.kind])).toEqual([
      ["canonical-infrastructure", "missing"],
      ["counter", "missing"],
    ]);
    expect(plan.steps.map(({ resourceId, kind }) => [resourceId, kind])).toEqual([
      ["counter", "deploy"],
    ]);
    expect(plan.capabilities).toHaveLength(1);
    expect(plan.requirements).toHaveLength(1);
  });

  it("keeps managed deployment work independent from external check drift", async () => {
    const desired: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [
        ...manifest().contracts,
        ...externalManifest([
          {
            id: "owner",
            caller: address("1"),
            readData: "0x11111111",
            expectedResult: "0x01",
          },
        ]).contracts,
      ],
    };
    const plan = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "100", blockHash: hash("1") };
        },
        async readCode({ address: target }) {
          if (target === CREATE2_FACTORY_V1_ADDRESS) return CREATE2_FACTORY_V1_RUNTIME_CODE;
          if (target === address("a")) return RUNTIME_CODE;
          return "0x";
        },
        async readCall() {
          return "0xff";
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    }).plan({ manifest: desired, chains: [1] });

    expect(plan.disposition).toBe("partial");
    expect(plan.cells.map(({ resourceId, status }) => [resourceId, status.kind])).toEqual([
      ["canonical-infrastructure", "drift"],
      ["counter", "missing"],
    ]);
    expect(plan.steps.map(({ resourceId, kind }) => [resourceId, kind])).toEqual([
      ["counter", "deploy"],
    ]);
    expect(plan.steps.some(({ resourceId }) => resourceId === "canonical-infrastructure")).toBe(
      false,
    );
    expect(plan.capabilities).toHaveLength(1);
    expect(plan.requirements).toHaveLength(1);
    expect(plan.requirements[0]?.calls).toEqual(plan.steps.map(({ call }) => call));
  });

  it("classifies immutable-address bytecode drift as blocked, never as a deploy call", async () => {
    const observed = observer(new Map([[1, OTHER_CODE]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: manifest(),
      chains: [1],
    });

    expect(plan.disposition).toBe("blocked");
    expect(plan.cells[0]?.status).toEqual({
      kind: "bytecode-drift",
      observedRuntimeCodeHash: keccak256(OTHER_CODE),
    });
    expect(plan.cells[0]?.expectedRuntimeCodeHash).toBe(keccak256(RUNTIME_CODE));
    expect(plan.steps).toEqual([]);
  });

  it("keeps independent missing work reviewable when another chain is blocked", async () => {
    const observed = observer(
      new Map<number, unknown>([
        [1, "0x"],
        [10, OTHER_CODE],
      ]),
    );
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: manifest(),
      chains: [10, 1],
    });

    expect(plan.disposition).toBe("partial");
    expect(plan.steps.map(({ chainId }) => chainId)).toEqual([1]);
    expect(plan.cells.map(({ status }) => status.kind)).toEqual(["missing", "bytecode-drift"]);
  });

  it("fails closed into unreadable cells without retaining raw provider failures", async () => {
    const observed = observer(new Map([[1, new Error("secret provider payload")]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: manifest(),
      chains: [1],
    });

    expect(plan.disposition).toBe("blocked");
    expect(plan.cells[0]?.status).toEqual({
      kind: "unreadable",
      source: "runtime-code",
      id: null,
      reason: "read-failed",
    });
    expect(JSON.stringify(plan)).not.toContain("secret provider payload");
  });

  it("distinguishes invalid code responses from read failures", async () => {
    const observed = observer(new Map([[1, "not-hex"]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: manifest(),
      chains: [1],
    });

    expect(plan.cells[0]?.status).toEqual({
      kind: "unreadable",
      source: "runtime-code",
      id: null,
      reason: "invalid-response",
    });
  });

  it("rejects unpinned or malformed snapshots before any code read", async () => {
    const reads: CodeReadRequest[] = [];
    const malformed: MoesiObservationAdapter = {
      async captureSnapshot(): Promise<unknown> {
        return { blockNumber: "1", blockHash: hash("1"), latest: true };
      },
      async readCode(request): Promise<Hex> {
        reads.push(request);
        return "0x";
      },
      async readCall(): Promise<Hex> {
        return "0x";
      },
      async checkBlockAncestry(): Promise<boolean> {
        return true;
      },
    };

    await expect(
      createMoesi({ observer: malformed }).plan({ manifest: manifest(), chains: [1] }),
    ).rejects.toMatchObject({
      name: "MoesiPlanningError",
      code: "invalid_snapshot",
      chainId: 1,
    } satisfies Partial<MoesiPlanningError>);
    expect(reads).toEqual([]);
  });

  it("rejects duplicate and invalid chain requests before observation", async () => {
    const observed = observer(new Map());
    await expect(
      createMoesi({ observer: observed.adapter }).plan({ manifest: manifest(), chains: [1, 1] }),
    ).rejects.toMatchObject({ code: "duplicate_chain", chainId: 1 });
    await expect(
      createMoesi({ observer: observed.adapter }).plan({ manifest: manifest(), chains: [] }),
    ).rejects.toMatchObject({ code: "invalid_chains", chainId: null });
    await expect(
      createMoesi({ observer: observed.adapter }).plan({
        manifest: manifest(),
        chains: Array.from({ length: 33 }, (_, index) => index + 1),
      }),
    ).rejects.toMatchObject({ code: "invalid_chains", chainId: null });
    await expect(
      createMoesi({ observer: observed.adapter }).plan({
        manifest: manifest(),
        chains: new Array(1),
      }),
    ).rejects.toMatchObject({ code: "invalid_chains", chainId: null });
    const adversarialChains = [0];
    Object.defineProperty(adversarialChains, "map", { value: () => [1] });
    await expect(
      createMoesi({ observer: observed.adapter }).plan({
        manifest: manifest(),
        chains: adversarialChains,
      }),
    ).rejects.toMatchObject({ code: "invalid_chains", chainId: null });
    expect(observed.reads).toEqual([]);
  });

  it("detects pinned configuration drift and compiles exact remediation calls", async () => {
    const desired = encodeAbiParameters([{ type: "uint256" }], [42n]);
    const current = encodeAbiParameters([{ type: "uint256" }], [0n]);
    const configured: MoesiManifest = {
      ...manifest(),
      contracts: [
        {
          ...firstContract(),
          configuration: [
            {
              id: "value",
              readData: "0x3fa4f245",
              expectedResult: desired,
              writeData: `0x55241077${desired.slice(2)}`,
              value: "0",
            },
          ],
        },
      ],
    };
    const base = observer(new Map([[1, RUNTIME_CODE]]));
    const calls: unknown[] = [];
    const adapter: MoesiObservationAdapter = {
      ...base.adapter,
      async readCall(request): Promise<Hex> {
        calls.push(request);
        return current;
      },
    };
    const plan = await createMoesi({ observer: adapter }).plan({
      manifest: configured,
      chains: [1],
    });

    expect(plan.disposition).toBe("changes");
    expect(plan.cells[0]?.status).toEqual({
      kind: "drift",
      observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      configurationMismatches: [{ id: "value", expectedResult: desired, observedResult: current }],
      callMismatches: [],
      storageMismatches: [],
    });
    expect(plan.steps).toMatchObject([
      {
        id: "counter:configure:value",
        resourceId: "counter",
        kind: "configure",
        configurationId: "value",
        drift: "configuration-drift",
        call: { data: `0x55241077${desired.slice(2)}`, value: "0" },
        postconditions: [
          {
            kind: "static-call",
            data: "0x3fa4f245",
            caller: address("0"),
            expectedResult: desired,
          },
        ],
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ caller: address("0") });
  });

  it("keeps managed attestations read-only while remediating mixed configuration drift", async () => {
    const desired: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [
        {
          ...firstContract(),
          configuration: [
            {
              id: "value",
              readData: "0x33333333",
              expectedResult: "0x02",
              writeData: "0x44444444",
              value: "0",
            },
          ],
          checks: [
            {
              id: "owner",
              caller: address("e"),
              readData: "0x22222222",
              expectedResult: "0x01",
            },
          ],
          storageChecks: [{ id: "slot", slot: hash("1"), expectedWord: hash("a") }],
        },
      ],
    };
    const calls: CallReadRequest[] = [];
    const events: string[] = [];
    const plan = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "100", blockHash: hash("1") };
        },
        async readCode() {
          events.push("runtime");
          return RUNTIME_CODE;
        },
        async readStorage(request) {
          events.push(`storage:${request.slot}`);
          return hash("a");
        },
        async readCall(request) {
          calls.push(request);
          events.push(`call:${request.data}`);
          return request.data === "0x22222222" ? "0xff" : "0x00";
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    }).plan({ manifest: desired, chains: [1] });

    expect(events).toEqual([
      "runtime",
      `storage:${hash("1")}`,
      "call:0x22222222",
      "call:0x33333333",
    ]);
    expect(calls.map(({ caller }) => caller)).toEqual([address("e"), address("0")]);
    expect(plan.disposition).toBe("partial");
    expect(plan.cells[0]?.configuration.map(({ id }) => id)).toEqual(["value"]);
    expect(plan.cells[0]?.checks.map(({ id }) => id)).toEqual(["owner"]);
    expect(plan.cells[0]?.status).toEqual({
      kind: "drift",
      observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      configurationMismatches: [{ id: "value", expectedResult: "0x02", observedResult: "0x00" }],
      callMismatches: [{ id: "owner", expectedResult: "0x01", observedResult: "0xff" }],
      storageMismatches: [],
    });
    expect(plan.steps.map(({ id, call }) => [id, call.data])).toEqual([
      ["counter:configure:value", "0x44444444"],
    ]);
    expect(plan.requirements[0]?.calls).toEqual([plan.steps[0]?.call]);
  });

  it("blocks managed attestation-only drift without synthesizing execution steps", async () => {
    const desired: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [
        {
          ...firstContract(),
          checks: [
            {
              id: "owner",
              caller: address("e"),
              readData: "0x22222222",
              expectedResult: "0x01",
            },
          ],
          storageChecks: [{ id: "slot", slot: hash("1"), expectedWord: hash("a") }],
        },
      ],
    };
    const plan = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "100", blockHash: hash("1") };
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        async readStorage() {
          return hash("f");
        },
        async readCall() {
          return "0xff";
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    }).plan({ manifest: desired, chains: [1] });

    expect(plan.disposition).toBe("blocked");
    expect(plan.cells[0]?.status).toMatchObject({
      kind: "drift",
      configurationMismatches: [],
      callMismatches: [{ id: "owner" }],
      storageMismatches: [{ id: "slot" }],
    });
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
  });

  it("plans missing deployment and configuration as one exact ordered convergence sequence", async () => {
    const configured: MoesiManifest = {
      ...manifest(),
      contracts: [
        {
          ...firstContract(),
          configuration: [
            {
              id: "z-last",
              readData: "0x11111111",
              expectedResult: "0x01",
              writeData: "0x22222222",
              value: "0",
            },
            {
              id: "a-first",
              readData: "0x33333333",
              expectedResult: "0x02",
              writeData: "0x44444444",
              value: "0",
            },
          ],
          checks: [
            {
              id: "owner",
              caller: address("e"),
              readData: "0x55555555",
              expectedResult: "0x01",
            },
          ],
          storageChecks: [{ id: "slot", slot: hash("1"), expectedWord: hash("a") }],
        },
      ],
    };
    const base = observer(new Map([[1, "0x"]]));
    let semanticReads = 0;
    const plan = await createMoesi({
      observer: {
        ...base.adapter,
        async readCall() {
          semanticReads += 1;
          throw new Error("contract does not exist yet");
        },
        async readStorage() {
          semanticReads += 1;
          throw new Error("contract does not exist yet");
        },
      },
    }).plan({ manifest: configured, chains: [1] });

    expect(plan.steps.map(({ id, kind, drift }) => [id, kind, drift])).toEqual([
      ["counter:deploy", "deploy", "missing"],
      ["counter:configure:a-first", "configure", "missing"],
      ["counter:configure:z-last", "configure", "missing"],
    ]);
    expect(plan.requirements[0]?.calls).toEqual(plan.steps.map(({ call }) => call));
    expect(plan.steps.flatMap(({ postconditions }) => postconditions)).not.toContainEqual(
      expect.objectContaining({ data: "0x55555555" }),
    );
    expect(semanticReads).toBe(0);
  });

  it("blocks when configuration evidence is unreadable", async () => {
    const configured: MoesiManifest = {
      ...manifest(),
      contracts: [
        {
          ...firstContract(),
          configuration: [
            {
              id: "value",
              readData: "0x3fa4f245",
              expectedResult: "0x00",
              writeData: "0x5524107700",
              value: "0",
            },
          ],
        },
      ],
    };
    const base = observer(new Map([[1, RUNTIME_CODE]]));
    const adapter: MoesiObservationAdapter = {
      ...base.adapter,
      async readCall(): Promise<Hex> {
        throw new Error("secret");
      },
    };
    const plan = await createMoesi({ observer: adapter }).plan({
      manifest: configured,
      chains: [1],
    });
    expect(plan.disposition).toBe("blocked");
    expect(plan.cells[0]?.status).toEqual({
      kind: "unreadable",
      source: "configuration",
      id: "value",
      reason: "read-failed",
      observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
    });
    expect(plan.steps).toEqual([]);
  });

  it("pins owner-dependent configuration reads to the declared EOA", async () => {
    const configured: MoesiManifest = {
      ...manifest(),
      contracts: [
        {
          ...firstContract(),
          sender: { kind: "owner-eoa", address: address("E") },
          configuration: [
            {
              id: "owner-value",
              readData: "0x3fa4f245",
              expectedResult: "0x01",
              writeData: "0x5524107701",
              value: "0",
            },
          ],
        },
      ],
    };
    const base = observer(new Map([[1, RUNTIME_CODE]]));
    const calls: unknown[] = [];
    const plan = await createMoesi({
      observer: {
        ...base.adapter,
        async readCall(request): Promise<Hex> {
          calls.push(request);
          return "0x00";
        },
      },
    }).plan({ manifest: configured, chains: [1] });

    expect(calls).toEqual([expect.objectContaining({ caller: address("e") })]);
    expect(plan.cells[0]?.configuration[0]?.caller).toBe(address("e"));
    expect(plan.steps[0]?.postconditions[0]).toMatchObject({
      kind: "static-call",
      caller: address("e"),
    });
  });

  it("compiles a declared owner EOA sender into steps and requirements", async () => {
    const owned: MoesiManifest = {
      ...manifest(),
      contracts: [
        {
          ...firstContract(),
          sender: { kind: "owner-eoa", address: address("E") },
        },
      ],
    };
    const observed = observer(new Map([[1, "0x"]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: owned,
      chains: [1],
    });

    expect(plan.steps[0]?.sender).toEqual({ kind: "reviewed-owner-eoa", address: address("e") });
    expect(plan.requirements[0]?.sender).toEqual({
      kind: "reviewed-owner-eoa",
      address: address("e"),
    });
  });

  it("compiles a declared smart-account sender into requirements", async () => {
    const owned: MoesiManifest = {
      ...manifest(),
      contracts: [
        {
          ...firstContract(),
          sender: { kind: "smart-account", accountId: "kernel:ops" },
        },
      ],
    };
    const observed = observer(new Map([[1, "0x"]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: owned,
      chains: [1],
    });

    expect(plan.requirements[0]?.sender).toEqual({
      kind: "logical-smart-account",
      accountId: "kernel:ops",
    });
  });

  it("merges declared enforcement to the strongest chain requirement", async () => {
    const first = firstContract();
    const enforced: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [
        first,
        {
          ...first,
          id: "admin",
          deployment: { ...first.deployment, salt: hash("c") },
          enforcement: {
            callScope: "required-onchain",
            expiry: "optional",
            operationLimit: "required",
          },
        },
      ],
    };
    const observed = observer(new Map([[1, "0x"]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: enforced,
      chains: [1],
    });

    expect(plan.requirements).toHaveLength(1);
    expect(plan.requirements[0]?.enforcement).toEqual({
      callScope: "required-onchain",
      expiry: "optional",
      operationLimit: "required",
    });
    expect(plan.requirements[0]?.calls).toHaveLength(2);
  });

  it("rejects one chain requiring two different senders", async () => {
    const first = firstContract();
    const conflicted: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [
        { ...first, sender: { kind: "owner-eoa", address: address("E") } },
        {
          ...first,
          id: "admin",
          deployment: { ...first.deployment, salt: hash("c") },
          sender: { kind: "owner-eoa", address: address("F") },
        },
      ],
    };
    const observed = observer(new Map([[1, "0x"]]));

    await expect(
      createMoesi({ observer: observed.adapter }).plan({ manifest: conflicted, chains: [1] }),
    ).rejects.toSatisfy(
      (error) => error instanceof MoesiPlanError && error.code === "conflicting_senders",
    );
  });
});
