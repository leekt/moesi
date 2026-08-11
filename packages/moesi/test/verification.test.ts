import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  createMoesi,
  MOESI_VERIFICATION_RESULT_VERSION,
  type MoesiObservationAdapter,
  type ReviewedPlan,
  reviewPlan,
} from "../src/index.js";
import { missingPlanDraft, testAddress, testHash, testManifest } from "./fixtures.js";

const RUNTIME_CODE = "0x6000" as const;
const OTHER_RUNTIME_CODE = "0x6001" as const;
const READ_DATA = "0x11111111" as const;
const EXPECTED_RESULT = "0x01" as const;

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
        version: "moesi.manifest/v1",
        contracts: [
          {
            kind: "external",
            id: "registry",
            address: externalAddress,
            expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
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
          status: {
            kind: "converged",
            observedRuntimeCodeHash: keccak256(RUNTIME_CODE),
            configurationResults: [],
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
      async checkBlockAncestry({ chainId, ancestor, descendant }) {
        events.push(`ancestry:${chainId}`);
        expect(ancestor).toEqual(plan.snapshots.find((snapshot) => snapshot.chainId === chainId));
        expect(Object.isFrozen(descendant)).toBe(true);
        try {
          (descendant as { blockNumber: string }).blockNumber = "999";
        } catch {
          // Frozen boundary values may throw on hostile mutation attempts.
        }
        return true;
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
    expect(events).toEqual([
      "capture:1",
      "ancestry:1",
      "code:1",
      "call:1",
      "capture:10",
      "ancestry:10",
      "code:10",
      "call:10",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.chains)).toBe(true);
    expect(Object.isFrozen(result.chains[0]?.snapshot)).toBe(true);
    expect(Object.isFrozen(result.chains[0]?.cells)).toBe(true);
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
