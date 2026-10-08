import { keccak256, padHex, toHex } from "cetane/utils";
import { describe, expect, it, vi } from "vitest";
import { createMoesi, type MoesiManifest, parseManifest, parseReviewedPlan } from "../src/index.js";

const address = `0x${"11".repeat(20)}` as const;
const blockHash = `0x${"22".repeat(32)}` as const;
const word = (amount: bigint) => padHex(toHex(amount), { size: 32 });
const source = (minimum = "100"): MoesiManifest => ({
  version: "moesi.manifest/v8",
  contracts: [
    {
      kind: "external",
      id: "deposit",
      address,
      expectedRuntimeCodeHash: keccak256("0x6000"),
      checks: [],
      storageChecks: [],
      semanticChecks: [
        {
          kind: "uint256-minimum",
          id: "funding",
          caller: address,
          readData: "0x12345678",
          minimum,
        },
      ],
    },
  ],
});
function fixture(value: unknown) {
  const readCall = vi.fn(async (_input: unknown) => value);
  const client = createMoesi({
    observer: {
      captureSnapshot: async () => ({ blockNumber: "10", blockHash }),
      readCode: async () => "0x6000",
      readCall,
      checkBlockAncestry: async () => true,
    },
  });
  return { client, readCall, plan: () => client.plan({ manifest: source(), chains: [1] }) };
}

describe("read-only uint256 minimum", () => {
  it.each([100n, 101n, (1n << 256n) - 1n])(
    "accepts the floor and values above it: %s",
    async (value) => {
      const { client, plan: makePlan, readCall } = fixture(word(value));
      const plan = await makePlan();
      expect(plan.disposition).toBe("converged");
      expect(plan.steps).toEqual([]);
      expect(plan.requirements).toEqual([]);
      expect(plan.cells[0]?.status).toMatchObject({ callResults: [{ result: word(value) }] });
      expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
      expect((await client.verify({ plan })).status).toBe("converged");
      expect(readCall.mock.calls[0]?.[0]).toMatchObject({
        snapshot: { blockHash },
        caller: address,
      });
    },
  );
  it("detects a fresh fall below the floor without creating a funding transaction", async () => {
    const { client, readCall, plan: makePlan } = fixture(word(100n));
    const reviewed = await makePlan();
    readCall.mockResolvedValue(word(99n));
    const drift = await makePlan();
    expect(drift.disposition).toBe("blocked");
    expect(drift.steps).toEqual([]);
    expect(drift.requirements).toEqual([]);
    expect(drift.cells[0]?.status).toMatchObject({
      kind: "drift",
      callMismatches: [{ observedResult: word(99n) }],
    });
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(drift)))).toEqual(drift);
    expect((await client.verify({ plan: reviewed })).status).toBe("drifted");
  });
  it.each(["0x", "0x01", `0x${"00".repeat(33)}`, null])(
    "rejects malformed ABI output %s",
    async (value) => {
      const { client, readCall, plan: makePlan } = fixture(word(100n));
      const reviewed = await makePlan();
      readCall.mockResolvedValue(value);
      expect((await makePlan()).cells[0]?.status).toMatchObject({
        kind: "unreadable",
        reason: "invalid-response",
      });
      expect((await client.verify({ plan: reviewed })).status).toBe("unreadable");
    },
  );
  it("does not convert RPC failure into balance drift", async () => {
    const { readCall, plan } = fixture(word(100n));
    readCall.mockRejectedValue(new Error("fixture failure"));
    expect((await plan()).cells[0]?.status).toMatchObject({
      kind: "unreadable",
      reason: "read-failed",
    });
  });
  it.each(["-1", "01", "1.0", "1e3", "", (1n << 256n).toString()])(
    "rejects noncanonical or out-of-range minimum %s",
    (minimum) => {
      expect(() => parseManifest(source(minimum))).toThrow();
    },
  );
  it("binds the minimum into the manifest and plan identity", async () => {
    const { client } = fixture(word(200n));
    const first = await client.plan({ manifest: source(), chains: [1] });
    const second = await client.plan({ manifest: source("101"), chains: [1] });
    expect(first.manifestHash).not.toBe(second.manifestHash);
    expect(first.planId).not.toBe(second.planId);
    const forged = JSON.parse(JSON.stringify(first));
    forged.cells[0].checks[0].expectedResult = word(99n);
    expect(() => parseReviewedPlan(forged)).toThrow();
  });
  it("rejects forged convergence and false drift above the floor", async () => {
    const plan = await fixture(word(101n)).plan();
    const forged = JSON.parse(JSON.stringify(plan));
    forged.cells[0].status.callResults[0].result = word(99n);
    expect(() => parseReviewedPlan(forged)).toThrow();
    forged.cells[0].status = {
      kind: "drift",
      observedRuntimeCodeHash: keccak256("0x6000"),
      configurationMismatches: [],
      storageMismatches: [],
      callMismatches: [
        {
          id: plan.cells[0]!.checks[0]!.id,
          expectedResult: word(100n),
          observedResult: word(101n),
        },
      ],
    };
    expect(() => parseReviewedPlan(forged)).toThrow();
  });
  it("rejects the previous manifest version before interpreting fields", () => {
    expect(() =>
      parseManifest(JSON.parse(JSON.stringify({ ...source(), version: "moesi.manifest/v7" }))),
    ).toThrow(expect.objectContaining({ code: "unsupported_manifest_version" }));
  });
});

it("preserves inclusive minima in fleet parity and distinguishes equality declarations", async () => {
  const { checkFleetParity } = await import("../src/fleet/index.js");
  const observer = {
    captureSnapshot: async () => ({ blockNumber: "10", blockHash }),
    readCode: async () => "0x6000",
    readCall: vi.fn(async () => word(101n)),
    checkBlockAncestry: async () => true,
  };
  const plan = await createMoesi({ observer }).plan({ manifest: source(), chains: [1] });
  const baseline = {
    version: "moesi.fleet-baseline/v2" as const,
    cells: [
      {
        chainId: 1,
        resourceId: "deposit",
        kind: "external" as const,
        address,
        expectedRuntimeCodeHash: keccak256("0x6000"),
        configuration: [],
        storageChecks: [],
        checks: plan.cells[0]!.checks,
      },
    ],
  };
  const run = () => checkFleetParity({ baseline, manifest: source(), chains: [1], observer });
  const match = await run();
  expect(match.status).toBe("match");
  expect(match.chains[0]?.cells[0]?.baseline?.liveState).toBe("converged");
  const exact = await checkFleetParity({
    baseline: {
      ...baseline,
      cells: [
        {
          ...baseline.cells[0]!,
          checks: baseline.cells[0]!.checks.map((check) => ({ ...check, kind: "call" as const })),
        },
      ],
    },
    manifest: source(),
    chains: [1],
    observer,
  });
  expect(exact.status).toBe("different");
  expect(exact.chains[0]?.cells[0]?.baseline?.liveState).toBe("drifted");
  expect(exact.chains[0]?.cells[0]?.candidate?.liveState).toBe("converged");
  observer.readCall.mockResolvedValue(word(99n));
  expect((await run()).chains[0]?.cells[0]?.baseline?.liveState).toBe("drifted");
  observer.readCall.mockResolvedValue("0x01");
  const malformed = await run();
  expect(malformed.status).toBe("unreadable");
  expect(malformed.chains[0]?.cells[0]?.baseline?.liveState).toBe("unreadable");
});
