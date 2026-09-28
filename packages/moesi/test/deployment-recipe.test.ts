import { readFileSync } from "node:fs";
import { type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATEX_FACTORY_V1_ADDRESS,
  compileDeploymentRecipe,
  createMoesi,
  type DeploymentRecipe,
  type MoesiObservationAdapter,
} from "../src/index.js";

const sender = {
  kind: "smart-account",
  accountId: "fleet",
  address: "0xc3a56de6dfc1dcef5113927ec09513918e8c44aa",
} as const;
const common = {
  initCode: "0x6002600c60003960026000f36000",
  value: "0",
  requiresRuntime: [],
} as const;
const entropy = "0x04a9469db98e61f23775c1";
const recipes = [
  { deployment: { ...common, kind: "create2-factory-v1", salt: `0x${"11".repeat(32)}` } },
  { deployment: { ...common, kind: "createx-create2-v1", entropy }, sender },
  { deployment: { ...common, kind: "createx-create3-v1", entropy }, sender },
  { deployment: { ...common, kind: "createx-create2-unguarded-v1", entropy } },
  { deployment: { ...common, kind: "createx-create3-unguarded-v1", entropy } },
] as const satisfies readonly DeploymentRecipe[];
const createXRuntime = readFileSync(
  new URL("./fixtures/CreateX.runtime.hex", import.meta.url),
  "utf8",
).trim() as Hex;
const observer: MoesiObservationAdapter = {
  captureSnapshot: async () => ({ blockNumber: "1", blockHash: `0x${"ab".repeat(32)}` }),
  readCode: async ({ address }) =>
    address === CREATEX_FACTORY_V1_ADDRESS
      ? createXRuntime
      : address === CREATE2_FACTORY_V1_ADDRESS
        ? "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
        : "0x",
  readCall: async () => "0x",
  checkBlockAncestry: async () => true,
};

describe("deployment recipe authoring", () => {
  it.each(recipes)("matches the reviewed plan for $deployment.kind", async (recipe) => {
    const compiled = compileDeploymentRecipe(recipe);
    const plan = await createMoesi({ observer }).plan({
      manifest: {
        version: "moesi.manifest/v6",
        contracts: [
          {
            kind: "managed",
            id: "target",
            ...recipe,
            expectedRuntimeCodeHash: keccak256("0x6000"),
            checks: [],
            storageChecks: [],
            configuration: [],
          },
        ],
      },
      chains: [31337],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.call).toEqual(compiled.call);
    expect(plan.cells[0]?.address).toBe(compiled.address);
    if (recipe.deployment.kind === "createx-create3-v1")
      expect(compiled.address).toBe("0xafdea3e6716239482c2378a3bf6d24fbdd99b077");
  });
  it("owns immutable inputs without manufacturing runtime or review evidence", () => {
    const input = {
      deployment: { ...recipes[0].deployment, requiresRuntime: ["z", "a"] },
    } as DeploymentRecipe;
    const result = compileDeploymentRecipe(input);
    expect(result.deployment.requiresRuntime).toEqual(["a", "z"]);
    expect(Object.isFrozen(result.call)).toBe(true);
    expect(Object.isFrozen(result.deployment.requiresRuntime)).toBe(true);
    expect(result).not.toHaveProperty("expectedRuntimeCodeHash");
    expect(result).not.toHaveProperty("planId");
    (input.deployment.requiresRuntime as string[])[0] = "changed";
    expect(result.deployment.requiresRuntime).toEqual(["a", "z"]);
  });
  it("rejects incomplete protected identities and malformed recipes at the shared boundary", () => {
    for (const input of [
      { deployment: recipes[2].deployment },
      { ...recipes[2], sender: { ...sender, accountId: "" } },
      { ...recipes[2], deployment: { ...recipes[2].deployment, entropy: "0x01" } },
      { ...recipes[0], deployment: { ...recipes[0].deployment, value: "01" } },
      { ...recipes[0], extra: true },
      {
        ...recipes[0],
        deployment: { ...recipes[0].deployment, requiresRuntime: ["same", "same"] },
      },
      {
        get deployment() {
          throw new Error("private input");
        },
      },
    ]) {
      try {
        compileDeploymentRecipe(input as never);
        throw new Error("invalid input accepted");
      } catch (error) {
        expect(error).toHaveProperty("code");
        expect(String(error)).not.toContain("private input");
        expect(error).not.toHaveProperty("cause");
      }
    }
  });
});
