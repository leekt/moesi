import {
  encodeAbiParameters,
  getCreate2Address,
  type Hex,
  keccak256,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";
import type {
  CodeReadRequest,
  MoesiManifest,
  MoesiObservationAdapter,
  SnapshotReference,
} from "../src/index.js";
import { createMoesi, type MoesiPlanningError } from "../src/index.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const RUNTIME_CODE = "0x6000" as const;
const OTHER_CODE = "0x6001" as const;

function manifest(): MoesiManifest {
  return {
    version: "moesi.manifest/v1",
    contracts: [
      {
        id: "counter",
        deployment: {
          kind: "create2-factory-v1",
          factory: address("a"),
          salt: hash("b"),
          initCode: "0x60006000",
          value: "7",
        },
        expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
        configuration: [],
      },
    ],
  };
}

function observer(codeByChain: ReadonlyMap<number, unknown>): {
  adapter: MoesiObservationAdapter;
  reads: CodeReadRequest[];
} {
  const reads: CodeReadRequest[] = [];
  return {
    reads,
    adapter: {
      async captureSnapshot(chainId): Promise<SnapshotReference> {
        return { blockNumber: BigInt(chainId * 100), blockHash: hash(chainId === 1 ? "1" : "2") };
      },
      async readCode(request): Promise<unknown> {
        reads.push(request);
        const value = codeByChain.get(request.chainId);
        if (value instanceof Error) throw value;
        return value;
      },
      async readCall(): Promise<Hex> {
        return "0x";
      },
    },
  };
}

describe("Moesi planner", () => {
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
      from: address("a"),
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
    expect(plan.steps[0]?.call.target).toBe(address("a"));
    expect(plan.steps[0]?.call.value).toBe(7n);
    expect(plan.steps[0]?.call.data.slice(0, 10)).toBe(toFunctionSelector("deploy(bytes32,bytes)"));
    expect(plan.policy.calls).toHaveLength(1);
    expect(plan.policy.perChainOperationLimit).toBe(1);
    expect(observed.reads[0]?.snapshot).toEqual(plan.snapshots[0]);

    const samePlan = await moesi.plan({ manifest: manifest(), chains: [1, 10] });
    expect(samePlan.planId).toBe(plan.planId);
  });

  it("returns converged evidence without calls when runtime bytecode matches", async () => {
    const observed = observer(new Map([[1, RUNTIME_CODE]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: manifest(),
      chains: [1],
    });

    expect(plan.disposition).toBe("converged");
    expect(plan.cells[0]?.status).toEqual({
      kind: "converged",
      observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      configurationResults: [],
    });
    expect(plan.steps).toEqual([]);
    expect(plan.policy).toEqual({ chainScope: "all", calls: [], perChainOperationLimit: 0 });
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
      reason: "read-failed",
      configurationId: null,
    });
    expect(
      JSON.stringify(plan, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
    ).not.toContain("secret provider payload");
  });

  it("distinguishes invalid code responses from read failures", async () => {
    const observed = observer(new Map([[1, "not-hex"]]));
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: manifest(),
      chains: [1],
    });

    expect(plan.cells[0]?.status).toEqual({
      kind: "unreadable",
      reason: "invalid-response",
      configurationId: null,
    });
  });

  it("rejects unpinned or malformed snapshots before any code read", async () => {
    const reads: CodeReadRequest[] = [];
    const malformed: MoesiObservationAdapter = {
      async captureSnapshot(): Promise<unknown> {
        return { blockNumber: 1n, blockHash: hash("1"), latest: true };
      },
      async readCode(request): Promise<Hex> {
        reads.push(request);
        return "0x";
      },
      async readCall(): Promise<Hex> {
        return "0x";
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
    expect(observed.reads).toEqual([]);
  });

  it("detects pinned configuration drift and compiles exact remediation calls", async () => {
    const desired = encodeAbiParameters([{ type: "uint256" }], [42n]);
    const current = encodeAbiParameters([{ type: "uint256" }], [0n]);
    const configured: MoesiManifest = {
      ...manifest(),
      contracts: [
        {
          ...manifest().contracts[0]!,
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
      kind: "configuration-drift",
      observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
      mismatches: [{ id: "value", expectedResult: desired, observedResult: current }],
    });
    expect(plan.steps).toMatchObject([
      {
        id: "counter:configure:value",
        resourceId: "counter",
        kind: "configure",
        configurationId: "value",
        drift: "configuration-drift",
        call: { data: `0x55241077${desired.slice(2)}`, value: 0n },
        postconditions: [{ kind: "static-call", data: "0x3fa4f245", expectedResult: desired }],
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("blocks when configuration evidence is unreadable", async () => {
    const configured: MoesiManifest = {
      ...manifest(),
      contracts: [
        {
          ...manifest().contracts[0]!,
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
      reason: "configuration-read-failed",
      configurationId: "value",
    });
    expect(plan.steps).toEqual([]);
  });
});
