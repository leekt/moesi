import { readFileSync } from "node:fs";
import type { Hex } from "cetane";
import { encodeFunctionData, keccak256, padHex, parseAbi, toHex } from "cetane/utils";
import { describe, expect, it } from "vitest";
import { createMoesi, type MoesiObservationAdapter, parseManifest } from "../src/index.js";
import { compileResourceChecks } from "../src/manifest/semantic.js";

const manifest = parseManifest(
  JSON.parse(
    readFileSync(
      new URL("../../../infrastructure/oaath/421614.manifest.json", import.meta.url),
      "utf8",
    ),
  ),
);
const provenance = JSON.parse(
  readFileSync(
    new URL("../../../infrastructure/oaath/421614.provenance.json", import.meta.url),
    "utf8",
  ),
);
const word = (value: bigint) => padHex(toHex(value), { size: 32 });
const runtime = "0x6000";
const minimum = 10n ** 16n;
const key = (target: string, data: string) => `${target}:${data}`;
const resource = (id: string) => {
  const value = manifest.contracts.find((row) => row.id === id);
  if (!value || value.kind !== "external") throw new Error("fixture_resource_missing");
  return value;
};
function fixture() {
  // Only runtime pins are replaced with the fixture's bytes. Addresses, callers,
  // calldata, authority expectations and configurable floors come from the real manifest.
  const local = parseManifest({
    version: manifest.version,
    contracts: manifest.contracts.map((row) => ({
      ...row,
      expectedRuntimeCodeHash: keccak256(runtime),
    })),
  });
  const calls = new Map<string, Hex>();
  for (const row of local.contracts)
    for (const check of compileResourceChecks(row).checks) {
      calls.set(
        key(check.target, check.readData),
        check.kind === "uint256-minimum" ? word(minimum + 1n) : check.expectedResult,
      );
    }
  const code = new Map<string, Hex>();
  const observer: MoesiObservationAdapter = {
    captureSnapshot: async () => ({ blockNumber: "10", blockHash: `0x${"11".repeat(32)}` }),
    readCode: async ({ address }) => code.get(address) ?? runtime,
    readCall: async ({ target, data }) => calls.get(key(target, data)) ?? "0x",
    checkBlockAncestry: async () => true,
  };
  const client = createMoesi({ observer });
  return {
    calls,
    code,
    local,
    client,
    plan: () => client.plan({ manifest: local, chains: [421614] }),
  };
}

describe("OAAth Arbitrum Sepolia infrastructure", () => {
  it("pins every external runtime with retained provenance and exact balance subjects", () => {
    expect(manifest.contracts).toHaveLength(25);
    for (const row of manifest.contracts) {
      expect(row.kind).toBe("external");
      expect(
        provenance.runtimePins.find((pin: { resourceId: string }) => pin.resourceId === row.id),
      ).toMatchObject({
        address: resource(row.id).address,
        runtimeCodeHash: row.expectedRuntimeCodeHash,
      });
    }
    for (const [id, signature, subject] of [
      [
        "entryPoint",
        "function balanceOf(address) view returns (uint256)",
        resource("paymaster").address,
      ],
      [
        "multicall3",
        "function getEthBalance(address) view returns (uint256)",
        "0x749c5a45fb069db0b96375ade0c8e39b658e46af",
      ],
    ] as const) {
      const check = resource(id).semanticChecks.find((row) => row.kind === "uint256-minimum");
      expect(check).toMatchObject({
        minimum: minimum.toString(),
        readData: encodeFunctionData({
          abi: parseAbi([signature]),
          functionName: id === "entryPoint" ? "balanceOf" : "getEthBalance",
          args: [subject],
        }),
      });
    }
  });
  it("converges without executable calls and permits independently configured floors", async () => {
    const { client, local, plan } = fixture();
    const reviewed = await plan();
    expect(reviewed.disposition).toBe("converged");
    expect(reviewed.steps).toEqual([]);
    expect(reviewed.requirements).toEqual([]);
    for (const id of ["entryPoint", "multicall3"]) {
      const changed = {
        version: local.version,
        contracts: local.contracts.map((row) =>
          row.id !== id
            ? row
            : {
                ...row,
                semanticChecks: row.semanticChecks.map((check) =>
                  check.kind === "uint256-minimum"
                    ? { ...check, minimum: (minimum + 2n).toString() }
                    : check,
                ),
              },
        ),
      };
      const result = await client.plan({ manifest: changed, chains: [421614] });
      expect(result.manifestHash).not.toBe(reviewed.manifestHash);
      expect(
        result.cells.filter((row) => row.status.kind !== "converged").map((row) => row.resourceId),
      ).toEqual([id]);
      expect(result.steps).toEqual([]);
    }
  });
  it.each(["entryPoint", "multicall3"])(
    "detects %s balance drops in fresh verification",
    async (id) => {
      const { client, calls, plan } = fixture();
      const reviewed = await plan();
      const check = compileResourceChecks(resource(id)).checks.find(
        (row) => row.kind === "uint256-minimum",
      )!;
      calls.set(key(check.target, check.readData), word(minimum - 1n));
      expect((await client.verify({ plan: reviewed })).status).toBe("drifted");
      expect((await plan()).cells.find((row) => row.resourceId === id)?.status).toMatchObject({
        kind: "drift",
        callMismatches: [{ id: check.id, observedResult: word(minimum - 1n) }],
      });
      calls.set(key(check.target, check.readData), "0x");
      expect((await client.verify({ plan: reviewed })).status).toBe("unreadable");
    },
  );
  it.each(["owner.owner", "signer", "pendingOwner"])(
    "detects changed paymaster authority: %s",
    async (id) => {
      const { calls, plan } = fixture();
      const check = compileResourceChecks(resource("paymaster")).checks.find(
        (row) => row.id === id,
      )!;
      calls.set(key(check.target, check.readData), word(1n));
      expect(
        (await plan()).cells.find((row) => row.resourceId === "paymaster")?.status,
      ).toMatchObject({ kind: "drift", callMismatches: [{ id }] });
    },
  );
  it("detects module bytecode replacement and an incorrect chain assertion", async () => {
    const { calls, code, plan } = fixture();
    code.set(resource("callPolicy").address, "0x6001");
    const check = resource("multicall3").checks.find((row) => row.id === "chain-id")!;
    calls.set(key(resource("multicall3").address, check.readData), word(1n));
    const result = await plan();
    expect(result.cells.find((row) => row.resourceId === "callPolicy")?.status.kind).toBe(
      "bytecode-drift",
    );
    expect(result.cells.find((row) => row.resourceId === "multicall3")?.status.kind).toBe("drift");
    expect(result.disposition).toBe("blocked");
    expect(result.steps).toEqual([]);
  });
});
