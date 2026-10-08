import { keccak256, padHex, toHex } from "cetane/utils";
import { createMoesi } from "moesi";
import { checkFleetParity } from "moesi/fleet";
import { expect, it } from "vitest";
import { callCheckEvidence } from "../src/cell-evidence.js";
import { renderParityHuman } from "../src/parity-output.js";
import { formatSemanticCheck } from "../src/semantic-output.js";

it("never invents the observed balance from a satisfied minimum in a drifted cell", async () => {
  const address = `0x${"11".repeat(20)}` as const;
  const minimum = {
    kind: "uint256-minimum",
    id: "deposit",
    caller: address,
    readData: "0x12345678",
    minimum: "100",
  } as const;
  const observer = {
    captureSnapshot: async () => ({ blockNumber: "1", blockHash: `0x${"22".repeat(32)}` }),
    readCode: async () => "0x6000",
    readCall: async () => padHex(toHex(101n), { size: 32 }),
    checkBlockAncestry: async () => true,
  };
  const client = createMoesi({ observer });
  const plan = await client.plan({
    manifest: {
      version: "moesi.manifest/v8",
      contracts: [
        {
          kind: "external",
          id: "entrypoint",
          address,
          expectedRuntimeCodeHash: keccak256("0x6000"),
          storageChecks: [],
          checks: [
            {
              id: "other",
              caller: address,
              readData: "0xabcdef00",
              expectedResult: padHex("0x00", { size: 32 }),
            },
          ],
          semanticChecks: [minimum],
        },
      ],
    },
    chains: [1],
  });
  expect(plan.cells[0]?.status.kind).toBe("drift");
  expect(callCheckEvidence(plan.cells[0]!, "deposit")).toEqual({
    kind: "not-recorded",
    observed: "not-recorded",
  });
  expect(formatSemanticCheck(minimum)).toContain("minimum=100");
  const parity = await checkFleetParity({
    baseline: {
      version: "moesi.fleet-baseline/v2",
      cells: plan.cells.map((cell) => ({
        chainId: cell.chainId,
        resourceId: cell.resourceId,
        kind: "external",
        address: cell.address,
        expectedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
        configuration: [],
        storageChecks: [],
        checks: cell.checks,
      })),
    },
    manifest: plan.manifest,
    chains: [1],
    observer,
  });
  expect(renderParityHuman(parity)).toContain("call deposit expected=>=100 observed=0x");
});
