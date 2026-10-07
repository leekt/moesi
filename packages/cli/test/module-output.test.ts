import { keccak256 } from "cetane/utils";
import { type AccountModuleInventory, createMoesi, type MoesiManifest } from "moesi";
import { describe, expect, it } from "vitest";
import { moduleEvidenceLines } from "../src/module-output.js";
import { renderVerificationHuman, renderVerificationJson } from "../src/verification-output.js";

const address = `0x${"11".repeat(20)}` as const;
const hash = `0x${"ab".repeat(32)}` as const;
describe("module evidence output", () => {
  it("keeps historical install counts separate from installed state and incomplete coverage", async () => {
    const inventory: AccountModuleInventory = {
      profile: "kernel-0.4.0",
      account: address,
      snapshot: { chainId: 1, blockNumber: "10", blockHash: hash },
      entries: [],
      checked: [],
      history: {
        fromBlock: "1",
        toBlock: "10",
        nextBlock: "11",
        complete: true,
        counts: [{ type: "6", address, installed: 3, uninstalled: 2 }],
      },
      complete: false,
      reason: "unknown-context",
    };
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v7",
      contracts: [
        {
          kind: "external",
          id: "account",
          address,
          checks: [],
          storageChecks: [],
          semanticChecks: [],
          expectedRuntimeCodeHash: keccak256("0x6000"),
          accountModules: { profile: inventory.profile, fromBlock: "1", entries: [] },
        },
      ],
    };
    const client = createMoesi({
      observer: {
        captureSnapshot: async () => ({ blockNumber: "10", blockHash: hash }),
        readCode: async () => "0x6000",
        readCall: async () => "0x",
        checkBlockAncestry: async () => true,
        readAccountModules: async () => inventory,
      },
    });
    const plan = await client.plan({ manifest, chains: [1] });
    const result = await client.verify({ plan });
    const output = renderVerificationHuman(result, plan);
    expect(output).toContain("account-modules incomplete");
    expect(output).toContain("state-confirmed=0 complete=false reason=unknown-context");
    expect(output).toContain("module-history from=1 to=10 next=11 complete=true");
    expect(output).toContain("installed=3 uninstalled=2");
    expect(output).toContain("runtime satisfied");
    expect(JSON.parse(renderVerificationJson(result)).status).toBe("unreadable");
    expect(moduleEvidenceLines("test", { kind: "unreadable", reason: "unavailable" })).toEqual([
      "test account-modules unreadable reason=unavailable",
    ]);
  });
});
