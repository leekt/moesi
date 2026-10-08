import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  type CallReadRequest,
  createMoesi,
  MOESI_VERIFICATION_RESULT_VERSION,
  type MoesiObservationAdapter,
  type ReadOnlyCallCheck,
  type ReviewedPlan,
  reviewPlan,
  type StorageReadRequest,
  type StorageWordCheck,
} from "../src/index.js";
import { missingPlanDraft, testAddress, testHash, testManifest } from "./fixtures.js";

const RUNTIME_CODE = "0x6000" as const;
const OTHER_RUNTIME_CODE = "0x6001" as const;
const READ_DATA = "0x11111111" as const;
const EXPECTED_RESULT = "0x01" as const;
const EXTERNAL_ADDRESS = testAddress("a");
const STORAGE_SLOT = testHash("3");
const EXPECTED_WORD = testHash("4");
const DRIFTED_WORD = testHash("5");

function checkedExternalVerificationPlan(
  checks: readonly ReadOnlyCallCheck[] = [
    {
      id: "a-first",
      caller: testAddress("1"),
      readData: "0x11111111",
      expectedResult: "0x01",
    },
    {
      id: "b-second",
      caller: testAddress("2"),
      readData: "0x22222222",
      expectedResult: "0x02",
    },
  ],
  storageChecks: readonly StorageWordCheck[] = [],
): ReviewedPlan {
  const ordered = [...checks].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const orderedStorage = [...storageChecks].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return reviewPlan({
    manifest: {
      version: "moesi.manifest/v8",
      contracts: [
        {
          kind: "external",
          semanticChecks: [],
          id: "registry",
          address: EXTERNAL_ADDRESS,
          expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
          checks,
          storageChecks,
        },
      ],
    },
    snapshots: [{ chainId: 1, blockNumber: "1", blockHash: testHash("1") }],
    capabilities: [],
    cells: [
      {
        resourceId: "registry",
        chainId: 1,
        address: EXTERNAL_ADDRESS,
        expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
        configuration: [],
        checks: ordered.map(({ id, caller, readData, expectedResult }) => ({
          kind: "call" as const,
          target: EXTERNAL_ADDRESS,
          id,
          caller,
          readData,
          expectedResult,
        })),
        storageChecks: orderedStorage.map((check) => ({ ...check, kind: "word" })),
        status: {
          kind: "converged",
          observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
          configurationResults: [],
          callResults: ordered.map(({ id, expectedResult }) => ({
            id,
            result: expectedResult,
          })),
          storageResults: orderedStorage.map(({ id, expectedWord }) => ({
            id,
            word: expectedWord,
          })),
        },
      },
    ],
    steps: [],
  });
}

function verificationPlan(chainIds: readonly number[] = [1]): ReviewedPlan {
  return reviewPlan(
    missingPlanDraft({
      chainIds,
      manifest: testManifest({
        runtimeHash: keccak256(RUNTIME_CODE),
        configuration: [
          {
            id: "value",
            readData: READ_DATA,
            expectedResult: EXPECTED_RESULT,
            writeData: "0x22222222",
            value: "0",
          },
        ],
      }),
    }),
  );
}

describe("standalone semantic verification", () => {
  it("verifies an external cell with the unchanged exact runtime result schema", async () => {
    const externalAddress = testAddress("a");
    const plan = reviewPlan({
      manifest: {
        version: "moesi.manifest/v8",
        contracts: [
          {
            kind: "external",
            semanticChecks: [],
            id: "registry",
            address: externalAddress,
            expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
            checks: [],
            storageChecks: [],
          },
        ],
      },
      snapshots: [{ chainId: 1, blockNumber: "1", blockHash: testHash("1") }],
      capabilities: [],
      cells: [
        {
          resourceId: "registry",
          chainId: 1,
          address: externalAddress,
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
      ],
      steps: [],
    });
    const readCall = vi.fn();
    const readCode = vi.fn(async ({ address }: { readonly address: string }) => {
      expect(address).toBe(externalAddress);
      return RUNTIME_CODE;
    });
    const result = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "2", blockHash: testHash("2") };
        },
        async checkBlockAncestry() {
          return true;
        },
        readCode,
        readCall,
      },
    }).verify({ plan });

    expect(result.status).toBe("converged");
    expect(result.chains[0]?.cells[0]).toEqual({
      resourceId: "registry",
      address: externalAddress,
      expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      storageChecks: [],
      callChecks: [],
      configurations: [],
      status: {
        kind: "satisfied",
        observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      },
    });
    expect(Object.keys(result.chains[0]?.cells[0] ?? {})).not.toContain("resourceKind");
    expect(readCode).toHaveBeenCalledTimes(1);
    expect(readCall).not.toHaveBeenCalled();
  });

  it("freshly verifies external checks at the exact target, caller, calldata, and snapshot", async () => {
    const plan = checkedExternalVerificationPlan();
    const calls: CallReadRequest[] = [];
    const events: string[] = [];
    const result = await createMoesi({
      observer: {
        async captureSnapshot() {
          events.push("snapshot");
          return { blockNumber: "2", blockHash: testHash("2") };
        },
        async checkBlockAncestry() {
          events.push("ancestry");
          return true;
        },
        async readCode({ address, snapshot }) {
          events.push("runtime");
          expect(address).toBe(EXTERNAL_ADDRESS);
          expect(snapshot).toEqual({ chainId: 1, blockNumber: "2", blockHash: testHash("2") });
          return RUNTIME_CODE;
        },
        async readCall(request) {
          calls.push(request);
          events.push(`check:${request.data}`);
          return request.data === "0x11111111" ? "0x01" : "0x02";
        },
      },
    }).verify({ plan });

    expect(events).toEqual(["snapshot", "runtime", "check:0x11111111", "check:0x22222222"]);
    expect(calls).toEqual([
      {
        chainId: 1,
        target: EXTERNAL_ADDRESS,
        data: "0x11111111",
        caller: testAddress("1"),
        snapshot: result.chains[0]?.snapshot,
      },
      {
        chainId: 1,
        target: EXTERNAL_ADDRESS,
        data: "0x22222222",
        caller: testAddress("2"),
        snapshot: result.chains[0]?.snapshot,
      },
    ]);
    expect(result.status).toBe("converged");
    expect(result.chains[0]?.cells[0]?.callChecks).toEqual([
      {
        kind: "call",
        target: EXTERNAL_ADDRESS,
        id: "a-first",
        expectedResult: "0x01",
        status: { kind: "satisfied", observedResult: "0x01" },
      },
      {
        kind: "call",
        target: EXTERNAL_ADDRESS,
        id: "b-second",
        expectedResult: "0x02",
        status: { kind: "satisfied", observedResult: "0x02" },
      },
    ]);
  });

  it("reports external check drift while continuing through readable checks", async () => {
    const plan = checkedExternalVerificationPlan();
    const readCall = vi.fn(async ({ data }: CallReadRequest) =>
      data === "0x11111111" ? "0xff" : "0x02",
    );
    const result = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "2", blockHash: testHash("2") };
        },
        async checkBlockAncestry() {
          return true;
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        readCall,
      },
    }).verify({ plan });

    expect(readCall).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("drifted");
    expect(result.chains[0]?.cells[0]).toEqual({
      resourceId: "registry",
      address: EXTERNAL_ADDRESS,
      expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      storageChecks: [],
      callChecks: [
        {
          kind: "call",
          target: EXTERNAL_ADDRESS,
          id: "a-first",
          expectedResult: "0x01",
          status: { kind: "drifted", observedResult: "0xff" },
        },
        {
          kind: "call",
          target: EXTERNAL_ADDRESS,
          id: "b-second",
          expectedResult: "0x02",
          status: { kind: "satisfied", observedResult: "0x02" },
        },
      ],
      configurations: [],
      status: {
        kind: "drifted",
        observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      },
    });
  });

  it("reports the first unreadable external check even with concurrent reads", async () => {
    const plan = checkedExternalVerificationPlan();
    const readCall = vi.fn(async ({ data }: CallReadRequest) => {
      if (data === "0x11111111") {
        throw new Error("credential-bearing external verification response");
      }
      throw new Error("second concurrent check also failed");
    });
    const result = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "2", blockHash: testHash("2") };
        },
        async checkBlockAncestry() {
          return true;
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        readCall,
      },
    }).verify({ plan });

    expect(readCall).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("unreadable");
    expect(result.chains[0]?.cells[0]?.callChecks).toEqual([
      {
        kind: "call",
        target: EXTERNAL_ADDRESS,
        id: "a-first",
        expectedResult: "0x01",
        status: { kind: "unreadable", reason: "read-failed" },
      },
    ]);
    expect(result.chains[0]?.cells[0]?.status).toEqual({
      kind: "unreadable",
      reason: "call-read-failed",
    });
    expect(JSON.stringify(result)).not.toContain(
      "credential-bearing external verification response",
    );
  });

  it("verifies external storage before calls at one fresh pinned snapshot", async () => {
    const plan = checkedExternalVerificationPlan(undefined, [
      { id: "implementation", slot: STORAGE_SLOT, expectedWord: EXPECTED_WORD },
    ]);
    const events: string[] = [];
    const readStorage = vi.fn(async (request: StorageReadRequest) => {
      events.push("storage");
      expect(request).toEqual({
        chainId: 1,
        address: EXTERNAL_ADDRESS,
        slot: STORAGE_SLOT,
        snapshot: { chainId: 1, blockNumber: "2", blockHash: testHash("2") },
      });
      expect(Object.isFrozen(request.snapshot)).toBe(true);
      return EXPECTED_WORD;
    });
    const readCall = vi.fn(async ({ data }: CallReadRequest) => {
      events.push(`call:${data}`);
      return data === "0x11111111" ? "0x01" : "0x02";
    });
    const result = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "2", blockHash: testHash("2") };
        },
        async checkBlockAncestry() {
          return true;
        },
        async readCode() {
          events.push("runtime");
          return RUNTIME_CODE;
        },
        readStorage,
        readCall,
      },
    }).verify({ plan });

    expect(events).toEqual(["runtime", "storage", "call:0x11111111", "call:0x22222222"]);
    expect(result.chains[0]?.cells[0]?.storageChecks).toEqual([
      {
        kind: "word",
        id: "implementation",
        slot: STORAGE_SLOT,
        expectedWord: EXPECTED_WORD,
        status: { kind: "satisfied", observedWord: EXPECTED_WORD },
      },
    ]);
    expect(result.status).toBe("converged");
  });

  it("reports readable storage drift and continues through external calls", async () => {
    const plan = checkedExternalVerificationPlan(undefined, [
      { id: "implementation", slot: STORAGE_SLOT, expectedWord: EXPECTED_WORD },
    ]);
    const readCall = vi.fn(async ({ data }: CallReadRequest) =>
      data === "0x11111111" ? "0x01" : "0x02",
    );
    const result = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "2", blockHash: testHash("2") };
        },
        async checkBlockAncestry() {
          return true;
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        async readStorage() {
          return DRIFTED_WORD;
        },
        readCall,
      },
    }).verify({ plan });

    expect(readCall).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("drifted");
    expect(result.chains[0]?.cells[0]?.storageChecks).toEqual([
      {
        kind: "word",
        id: "implementation",
        slot: STORAGE_SLOT,
        expectedWord: EXPECTED_WORD,
        status: { kind: "drifted", observedWord: DRIFTED_WORD },
      },
    ]);
  });

  it("stops later storage and calls on unavailable, failed, or malformed storage", async () => {
    const plan = checkedExternalVerificationPlan(undefined, [
      { id: "a-first", slot: STORAGE_SLOT, expectedWord: EXPECTED_WORD },
      { id: "b-later", slot: testHash("6"), expectedWord: EXPECTED_WORD },
    ]);
    const cases: readonly {
      readonly expectedCellReason:
        | "storage-unavailable"
        | "storage-read-failed"
        | "storage-invalid-response";
      readonly expectedCheckReason: "unavailable" | "read-failed" | "invalid-response";
      readonly readStorage?: MoesiObservationAdapter["readStorage"];
    }[] = [
      { expectedCellReason: "storage-unavailable", expectedCheckReason: "unavailable" },
      {
        expectedCellReason: "storage-read-failed",
        expectedCheckReason: "read-failed",
        async readStorage() {
          throw new Error("credential-bearing storage response");
        },
      },
      {
        expectedCellReason: "storage-invalid-response",
        expectedCheckReason: "invalid-response",
        async readStorage() {
          return "0x07";
        },
      },
    ];

    for (const testCase of cases) {
      const readCall = vi.fn();
      const observer: MoesiObservationAdapter = {
        async captureSnapshot() {
          return { blockNumber: "2", blockHash: testHash("2") };
        },
        async checkBlockAncestry() {
          return true;
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        readCall,
        ...(testCase.readStorage === undefined ? {} : { readStorage: testCase.readStorage }),
      };
      const result = await createMoesi({ observer }).verify({ plan });
      expect(result.chains[0]?.cells[0]).toMatchObject({
        storageChecks: [
          {
            id: "a-first",
            slot: STORAGE_SLOT,
            expectedWord: EXPECTED_WORD,
            status: { kind: "unreadable", reason: testCase.expectedCheckReason },
          },
        ],
        callChecks: [],
        configurations: [],
        status: { kind: "unreadable", reason: testCase.expectedCellReason },
      });
      expect(readCall).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("credential-bearing storage response");
    }
  });

  it("verifies managed storage, call checks, then configuration and retains every readable mismatch", async () => {
    const checkCaller = testAddress("7");
    const checkData = "0x22222222" as const;
    const configurationData = "0x33333333" as const;
    const plan = reviewPlan(
      missingPlanDraft({
        manifest: testManifest({
          runtimeHash: keccak256(RUNTIME_CODE),
          storageChecks: [{ id: "owner-slot", slot: STORAGE_SLOT, expectedWord: EXPECTED_WORD }],
          checks: [
            {
              id: "healthy",
              caller: checkCaller,
              readData: checkData,
              expectedResult: "0x02",
            },
          ],
          configuration: [
            {
              id: "value",
              readData: configurationData,
              expectedResult: "0x03",
              writeData: "0x44444444",
              value: "0",
            },
          ],
        }),
      }),
    );
    const events: string[] = [];
    const result = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "2", blockHash: testHash("2") };
        },
        async checkBlockAncestry() {
          return true;
        },
        async readCode() {
          events.push("runtime");
          return RUNTIME_CODE;
        },
        async readStorage() {
          events.push("storage");
          return DRIFTED_WORD;
        },
        async readCall({ data, caller }) {
          if (data === checkData) {
            events.push("call-check");
            expect(caller).toBe(checkCaller);
            return "0xff";
          }
          events.push("configuration");
          expect(data).toBe(configurationData);
          return "0xee";
        },
      },
    }).verify({ plan });

    expect(events).toEqual(["runtime", "storage", "call-check", "configuration"]);
    expect(result.status).toBe("drifted");
    expect(result.chains[0]?.cells[0]).toMatchObject({
      storageChecks: [
        {
          id: "owner-slot",
          expectedWord: EXPECTED_WORD,
          status: { kind: "drifted", observedWord: DRIFTED_WORD },
        },
      ],
      callChecks: [
        {
          id: "healthy",
          expectedResult: "0x02",
          status: { kind: "drifted", observedResult: "0xff" },
        },
      ],
      configurations: [
        {
          id: "value",
          expectedResult: "0x03",
          status: { kind: "drifted", observedResult: "0xee" },
        },
      ],
      status: { kind: "drifted", observedRuntimeCodeHash: keccak256(RUNTIME_CODE) },
    });

    const readCall = vi.fn(async ({ data }: CallReadRequest) => {
      if (data === checkData) throw new Error("credential-bearing managed check failure");
      throw new Error("configuration must not run after an unreadable call check");
    });
    const unreadable = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "2", blockHash: testHash("2") };
        },
        async checkBlockAncestry() {
          return true;
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        async readStorage() {
          return EXPECTED_WORD;
        },
        readCall,
      },
    }).verify({ plan });
    expect(readCall).toHaveBeenCalledOnce();
    expect(unreadable.chains[0]?.cells[0]).toMatchObject({
      storageChecks: [{ id: "owner-slot", status: { kind: "satisfied" } }],
      callChecks: [{ id: "healthy", status: { kind: "unreadable", reason: "read-failed" } }],
      configurations: [],
      status: { kind: "unreadable", reason: "call-read-failed" },
    });
    expect(JSON.stringify(unreadable)).not.toContain("credential-bearing managed check failure");
  });

  it("verifies every reviewed chain sequentially and returns one frozen plan-bound result", async () => {
    const plan = verificationPlan([10, 1]);
    const events: string[] = [];
    const observer: MoesiObservationAdapter = {
      async captureSnapshot(chainId) {
        events.push(`capture:${chainId}`);
        return {
          blockNumber: chainId === 1 ? "20" : "30",
          blockHash: testHash(chainId === 1 ? "a" : "b"),
        };
      },
      async checkBlockAncestry() {
        throw new Error("standalone verification must not walk block ancestry");
      },
      async readCode({ chainId, snapshot }) {
        events.push(`code:${chainId}`);
        expect(snapshot.blockNumber).toBe(chainId === 1 ? "20" : "30");
        expect(Object.isFrozen(snapshot)).toBe(true);
        return RUNTIME_CODE;
      },
      async readCall({ chainId, data, caller, snapshot }) {
        events.push(`call:${chainId}`);
        expect(data).toBe(READ_DATA);
        expect(caller).toBe(testAddress("0"));
        expect(snapshot.blockNumber).toBe(chainId === 1 ? "20" : "30");
        return EXPECTED_RESULT;
      },
    };

    const result = await createMoesi({ observer }).verify({ plan });

    expect(result).toMatchObject({
      version: MOESI_VERIFICATION_RESULT_VERSION,
      planId: plan.planId,
      manifestHash: plan.manifestHash,
      status: "converged",
    });
    expect(result.chains.map(({ chainId, status }) => ({ chainId, status }))).toEqual([
      { chainId: 1, status: "converged" },
      { chainId: 10, status: "converged" },
    ]);
    expect(result.chains[0]?.cells[0]?.configurations[0]?.status).toEqual({
      kind: "satisfied",
      observedResult: EXPECTED_RESULT,
    });
    expect(events).toEqual(["capture:1", "code:1", "call:1", "capture:10", "code:10", "call:10"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.chains)).toBe(true);
    expect(Object.isFrozen(result.chains[0]?.snapshot)).toBe(true);
    expect(Object.isFrozen(result.chains[0]?.cells)).toBe(true);
    expect(Object.isFrozen(result.chains[0]?.cells[0]?.callChecks)).toBe(true);
    expect(Object.isFrozen(result.chains[0]?.cells[0]?.configurations)).toBe(true);
  });

  it("derives whole-plan status with unreadable taking precedence over drift", async () => {
    const plan = verificationPlan([1, 10]);
    const observer: MoesiObservationAdapter = {
      async captureSnapshot(chainId) {
        return { blockNumber: "20", blockHash: testHash(chainId === 1 ? "a" : "b") };
      },
      async checkBlockAncestry() {
        return true;
      },
      async readCode({ chainId }) {
        if (chainId === 1) throw new Error("credential-bearing RPC detail");
        return OTHER_RUNTIME_CODE;
      },
      async readCall() {
        throw new Error("must not read configuration after runtime failure");
      },
    };

    const result = await createMoesi({ observer }).verify({ plan });

    expect(result.status).toBe("unreadable");
    expect(result.chains.map(({ chainId, status }) => ({ chainId, status }))).toEqual([
      { chainId: 1, status: "unreadable" },
      { chainId: 10, status: "drifted" },
    ]);
    expect(result.chains[0]?.cells[0]?.status).toEqual({
      kind: "unreadable",
      reason: "read-failed",
    });
    expect(result.chains[1]?.cells[0]?.status).toEqual({
      kind: "drifted",
      observedRuntimeCodeHash: keccak256(OTHER_RUNTIME_CODE),
    });
    expect(JSON.stringify(result)).not.toContain("credential-bearing RPC detail");
  });

  it("reports a fresh snapshot before the planning anchor without reading state", async () => {
    const plan = reviewPlan(
      missingPlanDraft({
        firstBlockNumber: 100n,
        manifest: testManifest({ runtimeHash: keccak256(RUNTIME_CODE) }),
      }),
    );
    const checkBlockAncestry = vi.fn();
    const readCode = vi.fn();
    const result = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "99", blockHash: testHash("a") };
        },
        checkBlockAncestry,
        readCode,
        async readCall() {
          return EXPECTED_RESULT;
        },
      },
    }).verify({ plan });

    expect(result.status).toBe("unreadable");
    expect(result.chains[0]?.cells[0]?.status).toEqual({
      kind: "unreadable",
      reason: "snapshot-before-anchor",
    });
    expect(checkBlockAncestry).not.toHaveBeenCalled();
    expect(readCode).not.toHaveBeenCalled();
  });

  it("verifies a plan arbitrarily older than the fresh snapshot without walking ancestry", async () => {
    const plan = reviewPlan(
      missingPlanDraft({
        firstBlockNumber: 100n,
        manifest: testManifest({ runtimeHash: keccak256(RUNTIME_CODE) }),
      }),
    );
    const checkBlockAncestry = vi.fn();
    const result = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "10000000", blockHash: testHash("a") };
        },
        checkBlockAncestry,
        async readCode() {
          return RUNTIME_CODE;
        },
        async readCall() {
          return EXPECTED_RESULT;
        },
      },
    }).verify({ plan });

    expect(result.status).toBe("converged");
    expect(result.chains[0]?.status).toBe("converged");
    expect(checkBlockAncestry).not.toHaveBeenCalled();
  });

  it("validates the exact ReviewedPlan before contacting the observer", async () => {
    const plan = verificationPlan();
    const tampered = JSON.parse(JSON.stringify(plan)) as ReviewedPlan;
    Object.assign(tampered, { planId: testHash("f") });
    const captureSnapshot = vi.fn();
    const client = createMoesi({
      observer: {
        captureSnapshot,
        async checkBlockAncestry() {
          return true;
        },
        async readCode() {
          return RUNTIME_CODE;
        },
        async readCall() {
          return EXPECTED_RESULT;
        },
      },
    });

    await expect(client.verify({ plan: tampered })).rejects.toMatchObject({
      code: "plan_identity_mismatch",
    });
    expect(captureSnapshot).not.toHaveBeenCalled();
  });
});
