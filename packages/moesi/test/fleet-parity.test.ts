import { getCreate2Address, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import { checkFleetParity, type FleetBaseline, parseFleetBaseline } from "../src/fleet/index.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  type MoesiObservationAdapter,
  MoesiObservationError,
} from "../src/index.js";
import { testAddress, testHash, testManifest } from "./fixtures.js";

const CODE = "0x6000";
const HASH = keccak256(CODE);
const ADDRESS = getCreate2Address({
  from: CREATE2_FACTORY_V1_ADDRESS,
  salt: testHash("b"),
  bytecode: "0x60006000",
}).toLowerCase() as `0x${string}`;
const CALLER = testAddress("0");
const WORD = testHash("0");
const configuration = [
  {
    id: "value",
    readData: "0x11111111" as const,
    expectedResult: "0x01" as const,
    writeData: "0x22222222" as const,
    value: "0",
  },
];
const manifest = () =>
  testManifest({
    runtimeHash: HASH,
    configuration,
    checks: [
      { id: "owner", caller: testAddress("a"), readData: "0x33333333", expectedResult: "0x01" },
    ],
    storageChecks: [{ id: "slot", slot: WORD, expectedWord: WORD }],
  });
function baseline(chains = [1]): FleetBaseline {
  return {
    version: "moesi.fleet-baseline/v2",
    cells: chains.map((chainId) => ({
      chainId,
      resourceId: "counter",
      kind: "managed",
      address: ADDRESS,
      expectedRuntimeCodeHash: HASH,
      configuration: [
        {
          id: "legacy-value",
          caller: CALLER,
          readData: "0x11111111",
          expectedResult: "0x01",
          after: [],
        },
      ],
      checks: [
        {
          kind: "call",
          id: "legacy-owner",
          target: ADDRESS,
          caller: testAddress("a"),
          readData: "0x33333333",
          expectedResult: "0x01",
        },
      ],
      storageChecks: [{ id: "legacy-slot", slot: WORD, expectedWord: WORD }],
    })),
  };
}
function fixture() {
  const state = { code: CODE as unknown, call: "0x01" as unknown, failChain: 0 };
  const captureSnapshot = vi.fn(async (chainId: number) => {
    if (chainId === state.failChain) throw new Error("private rpc details");
    return { blockNumber: "10", blockHash: testHash("a") };
  });
  const readCall = vi.fn(async () => {
    if (state.call instanceof Error) throw state.call;
    return state.call;
  });
  const observer: MoesiObservationAdapter = {
    captureSnapshot,
    readCall,
    async readCode() {
      return state.code;
    },
    async readStorage() {
      return WORD;
    },
    async checkBlockAncestry() {
      return true;
    },
  };
  return { state, captureSnapshot, readCall, observer };
}

describe("live fleet parity", () => {
  it("compares all declaration kinds at exact shared pins, independent of legacy row labels", async () => {
    const { observer, captureSnapshot, readCall } = fixture();
    const result = await checkFleetParity({
      baseline: baseline([1, 2]),
      manifest: manifest(),
      chains: [2, 1],
      observer,
    });
    expect(result.status).toBe("match");
    expect(result.chains.map(({ chainId }) => chainId)).toEqual([1, 2]);
    expect(captureSnapshot.mock.calls).toEqual([[1], [2]]);
    expect(readCall).toHaveBeenCalledTimes(8); // two plan reads and two shared comparison reads per chain
    for (const call of readCall.mock.calls)
      expect(call).toEqual([
        expect.objectContaining({
          caller: expect.any(String),
          snapshot: { chainId: expect.any(Number), blockNumber: "10", blockHash: testHash("a") },
        }),
      ]);
    expect(result.chains[0]!.cells[0]).toMatchObject({
      differences: [],
      baseline: { liveState: "converged" },
      candidate: { liveState: "converged" },
    });
    expect(
      Object.isFrozen(result.chains[0]!.cells[0]!.baseline!.configuration[0]!.observation),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("shows an address change and the different actual configured values", async () => {
    const { observer } = fixture();
    const old = baseline();
    const result = await checkFleetParity({
      baseline: { ...old, cells: [{ ...old.cells[0]!, address: testAddress("c") }] },
      manifest: manifest(),
      chains: [1],
      observer: {
        ...observer,
        async readCall({ target }) {
          return target === testAddress("c") ? "0x02" : "0x01";
        },
      },
    });
    expect(result.status).toBe("different");
    expect(result.chains[0]!.cells[0]!.differences).toEqual(
      expect.arrayContaining([
        { code: "address_mismatch" },
        {
          code: "read_observation_mismatch",
          readKind: "configuration",
          baselineId: "legacy-value",
          candidateId: "value",
        },
      ]),
    );
    expect(result.chains[0]!.cells[0]!.baseline!.configuration[0]!.observation).toEqual({
      kind: "readable",
      value: "0x02",
    });
  });

  it("finds changed expectations and removed rules even when addresses and live state are unchanged", async () => {
    const { observer } = fixture();
    const candidate = testManifest({
      runtimeHash: HASH,
      configuration: [{ ...configuration[0]!, expectedResult: "0x99" }],
    });
    const result = await checkFleetParity({
      baseline: baseline(),
      manifest: candidate,
      chains: [1],
      observer,
    });
    expect(result.status).toBe("different");
    expect(result.chains[0]!.cells[0]!.differences.map(({ code }) => code)).toEqual([
      "expected_result_mismatch",
      "read_missing",
      "read_missing",
    ]);
    expect(result.chains[0]!.candidatePlan!.disposition).toBe("changes");
  });

  it("does not confuse equal existing drift with convergence", async () => {
    const { observer, state } = fixture();
    state.call = "0x02";
    const result = await checkFleetParity({
      baseline: baseline(),
      manifest: manifest(),
      chains: [1],
      observer,
    });
    expect(result.status).toBe("match");
    expect(result.chains[0]!.cells[0]).toMatchObject({
      baseline: { liveState: "drifted" },
      candidate: { liveState: "drifted" },
    });
    expect(result.chains[0]!.candidatePlan!.disposition).not.toBe("converged");
  });

  it("finds lost peer prerequisites rather than treating unguarded writes as equivalent", async () => {
    const { observer } = fixture();
    const old = baseline();
    const result = await checkFleetParity({
      baseline: {
        ...old,
        cells: old.cells.map((cell) => ({
          ...cell,
          configuration: cell.configuration.map((row) => ({
            ...row,
            after: [{ chainId: 2, address: testAddress("b"), expectedRuntimeCodeHash: HASH }],
          })),
        })),
      },
      manifest: manifest(),
      chains: [1],
      observer: {
        ...observer,
        async readCode({ chainId }) {
          return chainId === 2 ? "0x" : CODE;
        },
      },
    });
    expect(result.status).toBe("different");
    expect(result.chains[0]!.cells[0]).toMatchObject({
      baseline: { liveState: "pending" },
      candidate: { liveState: "converged" },
      differences: [{ code: "peer_requirements_mismatch" }],
    });
  });

  it.each([null, new Error("private provider error"), "0x0"])(
    "never treats unreadable results as parity",
    async (failure) => {
      const { observer, state } = fixture();
      state.call = failure;
      const result = await checkFleetParity({
        baseline: baseline(),
        manifest: manifest(),
        chains: [1],
        observer,
      });
      expect(result.status).toBe("unreadable");
      expect(result.chains[0]!.cells[0]!.baseline!.liveState).toBe("unreadable");
      expect(JSON.stringify(result)).not.toContain("private provider error");
    },
  );

  it("retains safe causes and reports other chains when one cannot capture a pin", async () => {
    const { observer, state } = fixture();
    state.failChain = 2;
    const cause = {
      attempts: [{ endpoint: 0, category: "timeout" as const, rpcCode: null, httpStatus: null }],
    };
    const result = await checkFleetParity({
      baseline: baseline([1, 2]),
      manifest: manifest(),
      chains: [1, 2],
      observer: {
        ...observer,
        async readCall({ chainId }) {
          if (chainId === 1) throw new MoesiObservationError("observation_failed", cause);
          return "0x01";
        },
      },
    });
    expect(result.status).toBe("unreadable");
    expect(result.chains[0]!.cells[0]!.baseline!.configuration[0]!.observation).toMatchObject({
      kind: "unreadable",
      cause,
    });
    expect(result.chains[1]).toMatchObject({
      snapshot: null,
      candidatePlan: null,
      error: { code: "snapshot_unreadable" },
    });
    expect(JSON.stringify(result)).not.toContain("private rpc details");
  });

  it("fails missing baseline chain coverage before RPC and propagates cancellation", async () => {
    const { observer, captureSnapshot } = fixture();
    await expect(
      checkFleetParity({ baseline: baseline(), manifest: manifest(), chains: [2], observer }),
    ).rejects.toMatchObject({ code: "baseline_chain_missing" });
    expect(captureSnapshot).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort("private reason");
    await expect(
      checkFleetParity({
        baseline: baseline(),
        manifest: manifest(),
        chains: [1],
        observer,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: "observation_aborted" });
    expect(captureSnapshot).not.toHaveBeenCalled();
  });

  it("rejects stale versions, duplicate coverage, unknown fields and accessors without invoking them", () => {
    expect(() => parseFleetBaseline({ version: "moesi.fleet-baseline/v0" })).toThrowError(
      expect.objectContaining({ code: "unsupported_fleet_baseline_version" }),
    );
    const old = baseline();
    for (const input of [
      { ...old, privateData: "not allowed" },
      { ...old, cells: [...old.cells, ...old.cells] },
      {
        ...old,
        cells: old.cells.map((cell) => ({
          ...cell,
          configuration: [...cell.configuration, ...cell.configuration],
        })),
      },
      {
        ...old,
        cells: old.cells.map((cell) => ({
          ...cell,
          configuration: [{ ...cell.configuration[0], value: "secret" }],
        })),
      },
    ])
      expect(() => parseFleetBaseline(input)).toThrowError(
        expect.objectContaining({ code: "invalid_fleet_baseline" }),
      );
    const getter = vi.fn(() => "private getter");
    const hostile = { ...old };
    Object.defineProperty(hostile, "cells", { get: getter, enumerable: true });
    expect(() => parseFleetBaseline(hostile)).toThrowError(
      expect.objectContaining({ code: "invalid_fleet_baseline" }),
    );
    expect(getter).not.toHaveBeenCalled();
    expect(parseFleetBaseline(JSON.parse(JSON.stringify(old)))).toEqual(old);
  });
});
