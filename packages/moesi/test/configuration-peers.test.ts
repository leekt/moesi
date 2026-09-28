import { encodeAbiParameters, type Hex, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  createMoesi,
  MemoryDeploymentRunStore,
  type MoesiExecutionProvider,
  type MoesiObservationAdapter,
  parseDeploymentRunRecord,
  parseManifest,
  parseReviewedPlan,
  reviewPlan,
} from "../src/index.js";
import { testAddress, testHash, testManifest } from "./fixtures.js";

const CODE = "0x6000";
const PEER = { chainId: 2, address: testAddress("c"), expectedRuntimeCodeHash: keccak256(CODE) };
const SECOND = { ...PEER, address: testAddress("d") };
const WORD = encodeAbiParameters([{ type: "uint256" }], [1n]);
function manifest(peers = [PEER, PEER]) {
  return testManifest({
    runtimeHash: keccak256(CODE),
    configuration: peers.map((peer, i) => ({
      id: `row-${i}`,
      readData: `0x0000000${i}` as Hex,
      expectedResult: WORD,
      writeData:
        `0x11111111${encodeAbiParameters([{ type: "uint256[]" }], [[BigInt(i)]]).slice(2)}` as Hex,
      value: "0",
      batch: { key: "rows", parameters: ["uint256[]"], maxRows: 64 },
      after: [peer],
    })),
  });
}
function fixture() {
  const state = {
    code: CODE as unknown,
    snapshotFails: false,
    block: "10",
    ancestry: true,
    value: "0x" as Hex,
  };
  const captureSnapshot = vi.fn(async (chain: number) => {
    if (chain === 2 && state.snapshotFails) throw new Error("private RPC detail");
    return { blockNumber: chain === 2 ? state.block : "10", blockHash: testHash("a") };
  });
  const observer: MoesiObservationAdapter = {
    captureSnapshot,
    async readCode({ chainId, address }) {
      if (chainId === 2 && address === PEER.address) {
        if (state.code instanceof Error) throw state.code;
        return state.code;
      }
      return CODE;
    },
    async readCall() {
      return state.value;
    },
    async checkBlockAncestry({ chainId }) {
      return chainId === 2 ? state.ancestry : true;
    },
  };
  const store = new MemoryDeploymentRunStore();
  return {
    state,
    captureSnapshot,
    observer,
    store,
    moesi: createMoesi({ observer, runStore: store }),
  };
}

const submit = vi.fn<MoesiExecutionProvider["submit"]>(async () => {
  throw new Error("must not submit");
});
const provider: MoesiExecutionProvider = {
  id: "peer-test",
  async review({ plan }) {
    return {
      providerId: "peer-test",
      status: "supported",
      reasons: [],
      chains: plan.requirements.map(({ chainId }) => ({
        chainId,
        sender: testAddress("a"),
        accountId: null,
        route: "test",
        enforcement: {
          calls: "interactive-owner",
          expiry: "not-enforced",
          operationCount: "not-enforced",
        },
      })),
    };
  },
  async prepare({ plan }) {
    return { providerId: "peer-test", planId: plan.planId, binding: {} };
  },
  submit,
  async observe() {
    return { status: "pending" };
  },
};

describe("cross-chain configuration peer readiness", () => {
  it("deduplicates peers, pins once per peer chain and merges only ready rows", async () => {
    const { moesi, state, captureSnapshot } = fixture();
    state.code = "0x";
    const input = manifest([PEER, SECOND]);
    const plan = await moesi.plan({ manifest: input, chains: [1] });
    expect(plan.disposition).toBe("partial");
    expect(plan.cells[0]!.configuration.map((row) => row.readiness)).toEqual([
      "pending-peer",
      "ready",
    ]);
    expect(plan.steps.map((step) => step.configurationIds)).toEqual([["row-1"]]);
    expect(plan.peers.map((peer) => peer.status.kind)).toEqual(["missing", "available"]);
    expect(captureSnapshot.mock.calls.filter(([chainId]) => chainId === 2)).toHaveLength(1);
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(Object.isFrozen(plan.peers[0]!.snapshot)).toBe(true);
    state.code = CODE;
    const ready = await moesi.plan({ manifest: input, chains: [1] });
    expect(ready.disposition).toBe("changes");
    expect(ready.steps.map((step) => step.configurationIds)).toEqual([["row-0", "row-1"]]);
    expect(ready.planId).not.toBe(plan.planId);
  });

  it("retains a pending plan without executable writes and rechecks peers during verification", async () => {
    const { moesi, state } = fixture();
    state.code = "0x";
    state.value = WORD;
    const plan = await moesi.plan({ manifest: manifest(), chains: [1] });
    expect(plan.disposition).toBe("pending");
    expect(plan.peers).toHaveLength(1);
    expect(plan.steps).toEqual([]);
    const pending = await moesi.verify({ plan });
    expect(pending.status).toBe("unreadable");
    expect(pending.chains[0]!.cells[0]!.status).toMatchObject({
      kind: "unreadable",
      reason: "peer-pending",
      peer: { chainId: 2 },
    });
    state.code = CODE;
    expect((await moesi.verify({ plan })).status).toBe("converged");
  });

  it.each([
    ["0x6001", false, "bytecode-drift"],
    [null, false, "unreadable"],
    [new Error("private RPC detail"), false, "unreadable"],
    [CODE, true, "unreadable"],
  ])(
    "blocks unreadable or changed peers instead of treating them as pending",
    async (code, snapshotFails, kind) => {
      const { moesi, state } = fixture();
      state.code = code;
      state.snapshotFails = snapshotFails as boolean;
      const plan = await moesi.plan({ manifest: manifest(), chains: [1] });
      expect(plan.disposition).toBe("blocked");
      expect(plan.peers[0]!.status.kind).toBe(kind);
      expect(plan.cells[0]!.configuration[0]!.readiness).toBe("blocked-peer");
      expect(plan.steps).toEqual([]);
      expect(JSON.stringify(plan)).not.toContain("private RPC detail");
      expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    },
  );

  it.each(["disappeared", "earlier-pin", "unrelated-pin"])(
    "prevents submission and fences when a reviewed peer becomes %s",
    async (failure) => {
      const { moesi, state, store } = fixture();
      const plan = await moesi.plan({ manifest: manifest(), chains: [1] });
      const executionReview = await moesi.reviewExecution({ plan, provider });
      if (failure === "disappeared") state.code = "0x";
      if (failure === "earlier-pin") state.block = "9";
      if (failure === "unrelated-pin") state.ancestry = false;
      submit.mockClear();
      const result = await moesi.apply({ plan, provider, executionReview }).wait();
      expect(result.chains[0]!.execution).toMatchObject({
        kind: "failed",
        reason: "configuration-peer-unverified",
      });
      expect(submit).not.toHaveBeenCalled();
      const record = parseDeploymentRunRecord(await store.get(plan.planId));
      expect(record?.steps.map((step) => step.phase)).toEqual(["pending"]);
    },
  );

  it("does not claim convergence for a peer on an earlier or unrelated pin", async () => {
    const { moesi, state } = fixture();
    state.value = WORD;
    const plan = await moesi.plan({ manifest: manifest(), chains: [1] });
    state.ancestry = false;
    const result = await moesi.verify({ plan });
    expect(result.chains[0]!.cells[0]!.status).toMatchObject({
      kind: "unreadable",
      reason: "peer-ancestry-unverified",
    });
  });

  it("rejects contradictory identities, empty runtime hashes, forged readiness and peer pins", async () => {
    expect(() =>
      parseManifest(manifest([PEER, { ...PEER, expectedRuntimeCodeHash: testHash("b") }])),
    ).toThrow();
    expect(() =>
      parseManifest(manifest([{ ...PEER, expectedRuntimeCodeHash: keccak256("0x") }])),
    ).toThrow();
    const { moesi } = fixture();
    const plan = await moesi.plan({ manifest: manifest([PEER, SECOND]), chains: [1] });
    const { manifest: input, snapshots, capabilities, peers, cells, steps } = plan;
    const draft = { manifest: input, snapshots, capabilities, peers, cells, steps };
    expect(() => reviewPlan({ ...draft, peers: [] })).toThrowError(
      expect.objectContaining({ code: "invalid_peer" }),
    );
    expect(() =>
      reviewPlan({
        ...draft,
        cells: cells.map((cell) => ({
          ...cell,
          configuration: cell.configuration.map((row) => ({ ...row, readiness: "pending-peer" })),
        })),
      }),
    ).toThrowError(expect.objectContaining({ code: "manifest_mismatch" }));
    expect(() =>
      reviewPlan({
        ...draft,
        peers: peers.map((peer, i) => ({
          ...peer,
          snapshot: { ...peer.snapshot!, blockNumber: i ? "11" : "10" },
        })),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_peer" }));
    expect(() =>
      reviewPlan({
        ...draft,
        peers: peers.map((peer) => ({
          ...peer,
          status: { kind: "bytecode-drift", observedRuntimeCodeHash: keccak256("0x") },
        })),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_peer" }));
  });
});
