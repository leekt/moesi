import { getCreate2Address, type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type {
  ConfigurationRule,
  ContractResource,
  Create2FactoryDeployment,
  ExternalContractResource,
  ManagedContractResource,
  MoesiManifest,
  MoesiObservationAdapter,
  PlanDraft,
} from "../src/index.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  createMoesi,
  type MoesiPlanError,
  reviewPlan,
} from "../src/index.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const RUNTIME_CODE = "0x6000" as const;
const WRONG_RUNTIME_CODE = "0x6001" as const;
const CREATE2_FACTORY_V1_RUNTIME_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as const;

type Create2ManagedContractResource = Omit<ManagedContractResource, "deployment"> & {
  readonly deployment: Create2FactoryDeployment;
};

function managed(
  id: string,
  saltByte: string,
  requiresRuntime: readonly string[] = [],
  configuration: readonly ConfigurationRule[] = [],
): Create2ManagedContractResource {
  return {
    kind: "managed",
    id,
    deployment: {
      kind: "create2-factory-v1",
      salt: hash(saltByte),
      initCode: "0x60006000",
      value: "0",
      requiresRuntime,
    },
    expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
    configuration,
    checks: [],
    storageChecks: [],
  };
}

function external(id: string): ExternalContractResource {
  return {
    kind: "external",
    id,
    address: address("a"),
    expectedRuntimeCodeHash: keccak256(RUNTIME_CODE),
    checks: [],
    storageChecks: [],
  };
}

function target(resource: ManagedContractResource): string {
  if (resource.deployment.kind !== "create2-factory-v1") {
    throw new Error("expected CREATE2 factory test deployment");
  }
  return getCreate2Address({
    from: CREATE2_FACTORY_V1_ADDRESS,
    salt: resource.deployment.salt,
    bytecodeHash: keccak256(resource.deployment.initCode),
  }).toLowerCase();
}

function observer(input: {
  readonly readCode: (chainId: number, observedAddress: string) => unknown;
  readonly readCall?: (data: Hex) => unknown;
  readonly readStorage?: () => unknown;
}): MoesiObservationAdapter {
  return {
    async captureSnapshot(chainId) {
      return { blockNumber: "100", blockHash: hash(chainId === 1 ? "1" : "2") };
    },
    async readCode(request) {
      if (request.address === CREATE2_FACTORY_V1_ADDRESS) {
        return CREATE2_FACTORY_V1_RUNTIME_CODE;
      }
      return input.readCode(request.chainId, request.address);
    },
    async readCall(request) {
      return input.readCall?.(request.data) ?? "0x";
    },
    async readStorage() {
      return input.readStorage?.() ?? hash("0");
    },
    async checkBlockAncestry() {
      return true;
    },
  };
}

function manifest(contracts: readonly ContractResource[]): MoesiManifest {
  return { version: "moesi.manifest/v3", contracts };
}

describe("deployment runtime prerequisites", () => {
  it("emits the transitive missing closure in canonical topology before resource-ordered configuration", async () => {
    const dependent = managed(
      "a-dependent",
      "1",
      ["z-middle"],
      [
        {
          id: "a",
          readData: "0x11111111",
          expectedResult: "0x01",
          writeData: "0x22222222",
          value: "0",
        },
      ],
    );
    const middle = managed("z-middle", "2", ["m-base"]);
    const independent = managed("b-independent", "3");
    const base = managed(
      "m-base",
      "4",
      [],
      [
        {
          id: "z",
          readData: "0x33333333",
          expectedResult: "0x02",
          writeData: "0x44444444",
          value: "0",
        },
      ],
    );
    const plan = await createMoesi({ observer: observer({ readCode: () => "0x" }) }).plan({
      manifest: manifest([dependent, middle, independent, base]),
      chains: [1],
    });

    expect(plan.disposition).toBe("changes");
    expect(plan.steps.map(({ id }) => id)).toEqual([
      "b-independent:deploy",
      "m-base:deploy",
      "z-middle:deploy",
      "a-dependent:deploy",
      "m-base:configure:z",
      "a-dependent:configure:a",
    ]);
    expect(plan.requirements[0]?.calls).toEqual(plan.steps.map(({ call }) => call));
    expect(plan.requirements[0]?.postconditions).toEqual(
      plan.steps.flatMap(({ postconditions }) => postconditions),
    );

    const shuffled: PlanDraft = {
      manifest: plan.manifest,
      snapshots: [...plan.snapshots].reverse(),
      capabilities: [...plan.capabilities].reverse(),
      cells: [...plan.cells].reverse(),
      steps: [...plan.steps].reverse(),
    };
    const rereviewed = reviewPlan(shuffled);
    expect(rereviewed.planId).toBe(plan.planId);
    expect(rereviewed.steps.map(({ id }) => id)).toEqual(plan.steps.map(({ id }) => id));
    expect(rereviewed.requirements).toEqual(plan.requirements);
  });

  it.each([
    ["missing", "0x"],
    ["wrong", WRONG_RUNTIME_CODE],
    ["runtime-unreadable", new Error("credential-bearing prerequisite failure")],
  ] as const)("blocks a dependent when an external prerequisite runtime is %s", async (_, code) => {
    const prerequisite = external("registry");
    const dependent = managed("app", "1", [prerequisite.id]);
    const plan = await createMoesi({
      observer: observer({
        readCode(_chainId, observedAddress) {
          if (observedAddress !== prerequisite.address) return "0x";
          if (code instanceof Error) throw code;
          return code;
        },
      }),
    }).plan({ manifest: manifest([dependent, prerequisite]), chains: [1] });

    expect(plan.disposition).toBe("blocked");
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain("credential-bearing prerequisite failure");
  });

  it.each(["storage-check", "call-check", "configuration"] as const)(
    "accepts exact runtime despite later %s unreadability",
    async (source) => {
      const prerequisite: ContractResource =
        source === "configuration"
          ? managed(
              "prerequisite",
              "2",
              [],
              [
                {
                  id: "value",
                  readData: "0x11111111",
                  expectedResult: "0x01",
                  writeData: "0x22222222",
                  value: "0",
                },
              ],
            )
          : {
              ...external("prerequisite"),
              checks:
                source === "call-check"
                  ? [
                      {
                        id: "live",
                        caller: address("b"),
                        readData: "0x11111111",
                        expectedResult: "0x01",
                      },
                    ]
                  : [],
              storageChecks:
                source === "storage-check"
                  ? [{ id: "slot", slot: hash("1"), expectedWord: hash("2") }]
                  : [],
            };
      const dependent = managed("app", "1", [prerequisite.id]);
      const prerequisiteAddress =
        prerequisite.kind === "external" ? prerequisite.address : target(prerequisite);
      const plan = await createMoesi({
        observer: observer({
          readCode: (_chainId, observedAddress) =>
            observedAddress === prerequisiteAddress ? RUNTIME_CODE : "0x",
          readCall() {
            throw new Error("credential-bearing semantic failure");
          },
          readStorage() {
            throw new Error("credential-bearing semantic failure");
          },
        }),
      }).plan({ manifest: manifest([dependent, prerequisite]), chains: [1] });

      expect(plan.disposition).toBe("partial");
      expect(plan.steps.map(({ id }) => id)).toEqual(["app:deploy"]);
      expect(plan.requirements[0]?.calls).toEqual([plan.steps[0]?.call]);
      expect(
        plan.cells.find(({ resourceId }) => resourceId === prerequisite.id)?.status,
      ).toMatchObject({ kind: "unreadable", source });
      expect(JSON.stringify(plan)).not.toContain("credential-bearing semantic failure");
    },
  );

  it("recomputes prerequisite actionability and rejects a blocked missing cell's step", async () => {
    const prerequisite = {
      ...external("registry"),
      checks: [
        {
          id: "live",
          caller: address("b"),
          readData: "0x11111111" as const,
          expectedResult: "0x01" as const,
        },
      ],
    };
    const dependent = managed("app", "1", [prerequisite.id]);
    const plan = await createMoesi({
      observer: observer({
        readCode: (_chainId, observedAddress) =>
          observedAddress === prerequisite.address ? RUNTIME_CODE : "0x",
        readCall() {
          throw new Error("semantic failure");
        },
      }),
    }).plan({ manifest: manifest([dependent, prerequisite]), chains: [1] });
    const cells = structuredClone(plan.cells) as PlanDraft["cells"];
    const prerequisiteCell = cells.find(({ resourceId }) => resourceId === prerequisite.id);
    if (prerequisiteCell === undefined) throw new Error("missing prerequisite cell");
    (prerequisiteCell as { status: PlanDraft["cells"][number]["status"] }).status = {
      kind: "missing",
    };

    expect(() =>
      reviewPlan({
        manifest: plan.manifest,
        snapshots: plan.snapshots,
        capabilities: plan.capabilities,
        cells,
        steps: plan.steps,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "orphan_step", path: "plan.steps" }) as MoesiPlanError,
    );
  });

  it("keeps configuration drift actionable independently of deployment prerequisites", async () => {
    const prerequisite = external("registry");
    const configured = managed(
      "configured",
      "1",
      [prerequisite.id],
      [
        {
          id: "value",
          readData: "0x11111111",
          expectedResult: "0x01",
          writeData: "0x22222222",
          value: "0",
        },
      ],
    );
    const configuredAddress = target(configured);
    const plan = await createMoesi({
      observer: observer({
        readCode: (_chainId, observedAddress) =>
          observedAddress === configuredAddress ? RUNTIME_CODE : "0x",
        readCall: () => "0x00",
      }),
    }).plan({ manifest: manifest([configured, prerequisite]), chains: [1] });

    expect(plan.disposition).toBe("partial");
    expect(plan.capabilities).toEqual([]);
    expect(plan.steps.map(({ id }) => id)).toEqual(["configured:configure:value"]);
    expect(plan.requirements[0]?.calls).toEqual([plan.steps[0]?.call]);
  });

  it("resolves missing actionability independently on each chain", async () => {
    const prerequisite = external("registry");
    const dependent = managed("app", "1", [prerequisite.id]);
    const plan = await createMoesi({
      observer: observer({
        readCode: (chainId, observedAddress) =>
          observedAddress === prerequisite.address && chainId === 1 ? RUNTIME_CODE : "0x",
      }),
    }).plan({ manifest: manifest([dependent, prerequisite]), chains: [2, 1] });

    expect(plan.disposition).toBe("partial");
    expect(plan.steps.map(({ chainId, id }) => [chainId, id])).toEqual([[1, "app:deploy"]]);
    expect(plan.requirements.map(({ chainId }) => chainId)).toEqual([1]);
  });
});
