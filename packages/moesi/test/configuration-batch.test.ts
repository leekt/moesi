import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbi,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  createMoesi,
  type MoesiManifest,
  type PlanDraft,
  parseManifest,
  parseReviewedPlan,
  reviewPlan,
} from "../src/index.js";

const ABI = parseAbi([
  "function setTargetTokens(uint256[] chains, address[] sources, address[] targets, uint8[] decimals)",
  "function checkTargetToken(uint256 chain, address source, address target) view returns (uint8)",
]);
const SOURCE = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}` as Hex;
const FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const FACTORY_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

function manifest(count = 5, maxRows = 2): MoesiManifest {
  return {
    version: "moesi.manifest/v6",
    contracts: [
      {
        kind: "managed",
        id: "book",
        deployment: {
          kind: "create2-factory-v1",
          salt: HASH,
          initCode: "0x6002600c60003960026000f36000",
          value: "0",
          requiresRuntime: [],
        },
        expectedRuntimeCodeHash: keccak256("0x6000"),
        checks: [],
        storageChecks: [],
        configuration: Array.from({ length: count }, (_, i) => ({
          id: `route-${i}`,
          readData: encodeFunctionData({
            abi: ABI,
            functionName: "checkTargetToken",
            args: [BigInt(i + 2), SOURCE, TARGET],
          }),
          expectedResult: encodeAbiParameters([{ type: "uint8" }], [6]),
          writeData: encodeFunctionData({
            abi: ABI,
            functionName: "setTargetTokens",
            args: [[BigInt(i + 2)], [SOURCE], [TARGET], [6]],
          }),
          value: "0",
          batch: {
            key: "set-routes",
            parameters: ["uint256[]", "address[]", "address[]", "uint8[]"],
            maxRows,
          },
        })),
      },
    ],
  };
}
function client(drift = new Set([0, 2, 4]), missing = false) {
  return createMoesi({
    observer: {
      async captureSnapshot() {
        return { blockNumber: "1", blockHash: HASH };
      },
      async readCode({ address }) {
        return address === FACTORY ? FACTORY_CODE : missing ? "0x" : "0x6000";
      },
      async readCall({ data }) {
        const call = decodeFunctionData({ abi: ABI, data });
        if (call.functionName !== "checkTargetToken") throw new Error("fixture");
        return encodeAbiParameters(
          [{ type: "uint8" }],
          [drift.has(Number(call.args[0]) - 2) ? 18 : 6],
        );
      },
      async checkBlockAncestry() {
        return true;
      },
    },
  });
}

describe("literal configuration batch compilation", () => {
  it("merges only drifted rows, chunks deterministically, and retains every exact postcondition", async () => {
    const plan = await client().plan({ manifest: manifest(), chains: [2, 1] });
    expect(plan.steps).toHaveLength(4);
    expect(plan.steps.map(({ configurationIds }) => configurationIds)).toEqual([
      ["route-0", "route-2"],
      ["route-4"],
      ["route-0", "route-2"],
      ["route-4"],
    ]);
    for (const step of plan.steps) {
      const decoded = decodeFunctionData({ abi: ABI, data: step.call.data });
      expect(decoded.functionName).toBe("setTargetTokens");
      expect(decoded.args[0]).toEqual(
        step.configurationIds.map((id) => BigInt(Number(id.slice(6)) + 2)),
      );
      expect(step.postconditions).toHaveLength(step.configurationIds.length);
      expect(step.call.value).toBe("0");
    }
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect((await client(new Set()).plan({ manifest: manifest(), chains: [1] })).steps).toEqual([]);
  });

  it("deploys then configures every row when code is missing and handles a 143-row route matrix", async () => {
    const plan = await client(new Set(), true).plan({ manifest: manifest(143, 64), chains: [1] });
    expect(plan.steps.map(({ kind }) => kind)).toEqual([
      "deploy",
      "configure",
      "configure",
      "configure",
    ]);
    expect(plan.steps.map(({ configurationIds }) => configurationIds.length)).toEqual([
      0, 64, 64, 15,
    ]);
    expect(plan.steps.slice(1).flatMap(({ configurationIds }) => configurationIds)).toEqual(
      Array.from({ length: 143 }, (_, i) => `route-${i}`),
    );
  });

  it("rejects edited batching and omitted row postconditions even when a new plan identity is requested", async () => {
    const plan = await client().plan({ manifest: manifest(), chains: [1] });
    const { manifest: input, snapshots, capabilities, cells, steps } = plan;
    const draft: PlanDraft = { manifest: input, snapshots, capabilities, cells, steps };
    for (const changed of [
      { ...steps[0]!, configurationIds: ["route-0"] },
      { ...steps[0]!, postconditions: [steps[0]!.postconditions[0]!] },
      { ...steps[0]!, call: { ...steps[0]!.call, data: steps[1]!.call.data } },
    ])
      expect(() => reviewPlan({ ...draft, steps: [changed, steps[1]!] })).toThrowError(
        expect.objectContaining({ code: "orphan_step" }),
      );
  });

  it("rejects noncanonical rows, incompatible groups, interleaving and paid batch calls at the manifest boundary", () => {
    for (const mutate of [
      (rows: any[]) => {
        rows[0].value = "1";
      },
      (rows: any[]) => {
        rows[0].batch.maxRows = 0;
      },
      (rows: any[]) => {
        rows[0].batch.parameters = ["tuple[]"];
      },
      (rows: any[]) => {
        rows[0].writeData += "00";
      },
      (rows: any[]) => {
        rows[1].batch.maxRows = 3;
      },
      (rows: any[]) => {
        rows[1].writeData = `0xffffffff${rows[1].writeData.slice(10)}`;
      },
      (rows: any[]) => {
        delete rows[1].batch;
      },
      (rows: any[]) => {
        rows[0].writeData = encodeFunctionData({
          abi: ABI,
          functionName: "setTargetTokens",
          args: [[2n, 3n], [SOURCE], [TARGET], [6]],
        });
      },
    ]) {
      const input = structuredClone(manifest());
      mutate((input.contracts[0] as any).configuration);
      expect(() => parseManifest(input)).toThrowError(
        expect.objectContaining({ code: "invalid_resource" }),
      );
    }
  });
});
