import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { ExternalContractCheck, PlanDraft } from "../src/index.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
  DEFAULT_PLAN_ENFORCEMENT,
  MoesiPlanError,
  parseReviewedPlan,
  reviewPlan,
} from "../src/index.js";
import { missingPlanDraft, testHash, testManifest } from "./fixtures.js";

const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const address = (byte: string) => `0x${byte.repeat(40)}` as const;

function draft(): PlanDraft {
  return missingPlanDraft({
    manifest: testManifest({ id: "counter.deploy", runtimeHash: hash("d") }),
    chainIds: [10, 1],
    firstBlockNumber: 10n,
  });
}

function externalDraft(
  status: PlanDraft["cells"][number]["status"] = { kind: "missing" },
  checks: readonly ExternalContractCheck[] = [],
): PlanDraft {
  return {
    manifest: {
      version: "moesi.manifest/v1",
      contracts: [
        {
          kind: "external",
          id: "canonical-infrastructure",
          address: address("A"),
          expectedRuntimeCodeHash: hash("d"),
          checks,
        },
      ],
    },
    snapshots: [{ chainId: 1, blockNumber: "1", blockHash: hash("1") }],
    capabilities: [],
    cells: [
      {
        resourceId: "canonical-infrastructure",
        chainId: 1,
        address: address("A"),
        expectedRuntimeCodeHash: hash("d"),
        configuration: checks.map(({ id, caller, readData, expectedResult }) => ({
          id,
          caller,
          readData,
          expectedResult,
        })),
        status,
      } as PlanDraft["cells"][number],
    ],
    steps: [],
  };
}

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function mutableDraft(): Mutable<PlanDraft> {
  return structuredClone(draft()) as Mutable<PlanDraft>;
}

function stepAt(plan: Mutable<PlanDraft>, index: number): Mutable<PlanDraft["steps"][number]> {
  const step = plan.steps[index];
  if (!step) throw new Error(`missing test step ${index}`);
  return step;
}

function cellAt(plan: Mutable<PlanDraft>, index: number): Mutable<PlanDraft["cells"][number]> {
  const cell = plan.cells[index];
  if (!cell) throw new Error(`missing test cell ${index}`);
  return cell;
}

function snapshotFor(
  plan: Mutable<PlanDraft>,
  chainId: number,
): Mutable<PlanDraft["snapshots"][number]> {
  const snapshot = plan.snapshots.find((candidate) => candidate.chainId === chainId);
  if (!snapshot) throw new Error(`missing test snapshot ${chainId}`);
  return snapshot;
}

function capabilityFor(
  plan: Mutable<PlanDraft>,
  chainId: number,
): Mutable<PlanDraft["capabilities"][number]> {
  const capability = plan.capabilities.find((candidate) => candidate.chainId === chainId);
  if (!capability) throw new Error(`missing test capability ${chainId}`);
  return capability;
}

function requirementAt(
  plan: Mutable<ReturnType<typeof reviewPlan>>,
  index: number,
): Mutable<ReturnType<typeof reviewPlan>["requirements"][number]> {
  const requirement = plan.requirements[index];
  if (!requirement) throw new Error(`missing test requirement ${index}`);
  return requirement;
}

function expectPlanError(
  operation: () => unknown,
  code: MoesiPlanError["code"],
  path?: string,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MoesiPlanError);
    expect((error as MoesiPlanError).code).toBe(code);
    if (path !== undefined) expect((error as MoesiPlanError).path).toBe(path);
    return;
  }
  throw new Error(`expected MoesiPlanError ${code}`);
}

describe("reviewPlan", () => {
  it("owns normalized calls and derives provider-neutral requirements per chain", () => {
    const plan = reviewPlan(draft());

    expect(plan.version).toBe("moesi.reviewed-plan/v1");
    expect(plan.disposition).toBe("changes");
    expect(plan.snapshots.map(({ chainId }) => chainId)).toEqual([1, 10]);
    expect(plan.cells.map(({ chainId }) => chainId)).toEqual([1, 10]);
    expect(plan.steps[0]?.call.target).toBe(CREATE2_FACTORY_V1_ADDRESS);
    expect(plan.requirements).toEqual([
      {
        chainId: 1,
        calls: [plan.steps[0]!.call],
        sender: { kind: "sender-independent" },
        enforcement: DEFAULT_PLAN_ENFORCEMENT,
        postconditions: [plan.steps[0]!.postconditions[0]],
      },
      {
        chainId: 10,
        calls: [plan.steps[1]!.call],
        sender: { kind: "sender-independent" },
        enforcement: DEFAULT_PLAN_ENFORCEMENT,
        postconditions: [plan.steps[1]!.postconditions[0]],
      },
    ]);
    expect(plan.planId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces one identity and ASCII order for semantically identical input", () => {
    const left = mutableDraft();
    const right = mutableDraft();
    right.snapshots.reverse();
    right.capabilities.reverse();
    right.cells.reverse();
    right.steps.reverse();

    expect(reviewPlan(left).planId).toBe(reviewPlan(right).planId);

    const first = testManifest({ id: "i", salt: testHash("1") }).contracts[0]!;
    const second = testManifest({ id: "I", salt: testHash("2") }).contracts[0]!;
    const ascii = missingPlanDraft({
      manifest: { version: "moesi.manifest/v1", contracts: [first, second] },
    });
    expect(reviewPlan(ascii).cells.map(({ resourceId }) => resourceId)).toEqual(["I", "i"]);
  });

  it("deep-freezes the reviewed artifact without retaining caller objects", () => {
    const input = mutableDraft();
    const plan = reviewPlan(input);
    stepAt(input, 0).call.data = "0xffffffff";

    expect(plan.steps[0]?.call.data).not.toBe("0xffffffff");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.requirements)).toBe(true);
    expect(Object.isFrozen(plan.requirements[0]?.calls)).toBe(true);
    expect(() => {
      (plan.requirements as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it("snapshots draft array fields before validation", () => {
    const valid = draft();
    const reads = { snapshots: 0, capabilities: 0, cells: 0, steps: 0 };
    const source = Object.defineProperties(
      { manifest: valid.manifest },
      {
        snapshots: {
          enumerable: true,
          get() {
            reads.snapshots += 1;
            return reads.snapshots === 1 ? valid.snapshots : [];
          },
        },
        capabilities: {
          enumerable: true,
          get() {
            reads.capabilities += 1;
            return reads.capabilities === 1 ? valid.capabilities : [];
          },
        },
        cells: {
          enumerable: true,
          get() {
            reads.cells += 1;
            return reads.cells === 1 ? valid.cells : [];
          },
        },
        steps: {
          enumerable: true,
          get() {
            reads.steps += 1;
            return reads.steps === 1 ? valid.steps : [];
          },
        },
      },
    );

    const plan = reviewPlan(source as PlanDraft);
    expect(plan.snapshots).toHaveLength(2);
    expect(plan.capabilities).toHaveLength(2);
    expect(plan.cells).toHaveLength(2);
    expect(plan.steps).toHaveLength(2);
    expect(reads).toEqual({ snapshots: 1, capabilities: 1, cells: 1, steps: 1 });
  });

  it("rejects caller-supplied requirements instead of accepting two sources of truth", () => {
    const adversarial = { ...draft(), requirements: [] } as unknown as PlanDraft;
    expectPlanError(() => reviewPlan(adversarial), "unknown_field", "plan.requirements");
  });

  it("rejects non-canonical or contradictory deployment capability evidence", () => {
    const wrongAddress = mutableDraft();
    capabilityFor(wrongAddress, 1).address = address("9");
    expectPlanError(() => reviewPlan(wrongAddress), "invalid_capability");

    const wrongExpectedHash = mutableDraft();
    capabilityFor(wrongExpectedHash, 1).expectedRuntimeCodeHash = hash("e");
    expectPlanError(() => reviewPlan(wrongExpectedHash), "invalid_capability");

    const falseAvailability = mutableDraft();
    const available = capabilityFor(falseAvailability, 1).status;
    if (available.kind !== "available") throw new Error("missing available test capability");
    available.observedRuntimeCodeHash = hash("e");
    expectPlanError(() => reviewPlan(falseAvailability), "invalid_capability");

    const falseDrift = mutableDraft();
    capabilityFor(falseDrift, 1).status = {
      kind: "bytecode-drift",
      observedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
    };
    expectPlanError(() => reviewPlan(falseDrift), "invalid_capability");

    const emptyDrift = mutableDraft();
    capabilityFor(emptyDrift, 1).status = {
      kind: "bytecode-drift",
      observedRuntimeCodeHash: keccak256("0x"),
    };
    expectPlanError(() => reviewPlan(emptyDrift), "invalid_capability");
  });

  it("requires exactly one capability for each chain with missing resources", () => {
    const missing = mutableDraft();
    missing.capabilities = missing.capabilities.filter(({ chainId }) => chainId !== 1);
    expectPlanError(() => reviewPlan(missing), "missing_capability", "plan.capabilities");

    const duplicate = mutableDraft();
    duplicate.capabilities.push(structuredClone(capabilityFor(duplicate, 1)));
    expectPlanError(() => reviewPlan(duplicate), "duplicate_capability");

    const unexpected = mutableDraft();
    const firstCell = cellAt(unexpected, 0);
    firstCell.status = {
      kind: "converged",
      observedRuntimeCodeHash: firstCell.expectedRuntimeCodeHash,
      configurationResults: [],
    };
    unexpected.steps = unexpected.steps.filter(({ chainId }) => chainId !== firstCell.chainId);
    expectPlanError(() => reviewPlan(unexpected), "unexpected_capability");
  });

  it("blocks missing deployments unless their reviewed capability is available", () => {
    const blocked = missingPlanDraft() as Mutable<PlanDraft>;
    capabilityFor(blocked, 1).status = { kind: "missing" };
    blocked.steps = [];
    const reviewed = reviewPlan(blocked);
    expect(reviewed.disposition).toBe("blocked");
    expect(reviewed.requirements).toEqual([]);

    const invalid = missingPlanDraft() as Mutable<PlanDraft>;
    capabilityFor(invalid, 1).status = { kind: "missing" };
    expectPlanError(() => reviewPlan(invalid), "orphan_step", "plan.steps");
  });

  it("represents converged and blocked state without fabricating calls", () => {
    const converged = mutableDraft();
    const existing = converged.cells.find(({ chainId }) => chainId === 1)!;
    converged.cells = [
      {
        ...existing,
        status: {
          kind: "converged",
          observedRuntimeCodeHash: hash("d"),
          configurationResults: [],
        },
      },
    ];
    converged.snapshots = [snapshotFor(converged, 1)];
    converged.capabilities = [];
    converged.steps = [];
    const convergedPlan = reviewPlan(converged);
    expect(convergedPlan.disposition).toBe("converged");
    expect(convergedPlan.requirements).toEqual([]);

    const blocked = structuredClone(converged);
    cellAt(blocked, 0).status = {
      kind: "bytecode-drift",
      observedRuntimeCodeHash: hash("f"),
    };
    expect(reviewPlan(blocked).disposition).toBe("blocked");
  });

  it("treats external resources as exact-address verify-only evidence", () => {
    const converged = reviewPlan(
      externalDraft({
        kind: "converged",
        observedRuntimeCodeHash: hash("d"),
        configurationResults: [],
      }),
    );
    expect(converged.disposition).toBe("converged");
    expect(converged.manifest.contracts[0]).toEqual({
      kind: "external",
      id: "canonical-infrastructure",
      address: address("a"),
      expectedRuntimeCodeHash: hash("d"),
      checks: [],
    });
    expect(converged.cells[0]).toMatchObject({
      address: address("a"),
      expectedRuntimeCodeHash: hash("d"),
      configuration: [],
    });
    expect(converged.capabilities).toEqual([]);
    expect(converged.steps).toEqual([]);
    expect(converged.requirements).toEqual([]);

    for (const status of [
      { kind: "missing" as const },
      { kind: "bytecode-drift" as const, observedRuntimeCodeHash: hash("e") },
      { kind: "unreadable" as const, reason: "read-failed" as const, configurationId: null },
    ]) {
      const reviewed = reviewPlan(externalDraft(status));
      expect(reviewed.disposition).toBe("blocked");
      expect(reviewed.capabilities).toEqual([]);
      expect(reviewed.steps).toEqual([]);
      expect(reviewed.requirements).toEqual([]);
    }
  });

  it("exact-binds external cells to the embedded manifest", () => {
    const wrongAddress = structuredClone(externalDraft()) as Mutable<PlanDraft>;
    cellAt(wrongAddress, 0).address = address("b");
    expectPlanError(() => reviewPlan(wrongAddress), "manifest_mismatch", "plan.cells");

    const wrongRuntime = structuredClone(externalDraft()) as Mutable<PlanDraft>;
    cellAt(wrongRuntime, 0).expectedRuntimeCodeHash = hash("e");
    expectPlanError(() => reviewPlan(wrongRuntime), "manifest_mismatch", "plan.cells");

    const writable = structuredClone(externalDraft()) as Mutable<PlanDraft>;
    cellAt(writable, 0).configuration = [
      {
        id: "value",
        readData: "0x11111111",
        caller: address("1"),
        expectedResult: "0x01",
      },
    ];
    expectPlanError(() => reviewPlan(writable), "manifest_mismatch", "plan.cells");
  });

  it("exact-binds external check ids, callers, calldata, and expected results", () => {
    const checks: readonly ExternalContractCheck[] = [
      {
        id: "owner",
        caller: address("1"),
        readData: "0x11111111",
        expectedResult: "0x01",
      },
    ];
    const checked = externalDraft(
      {
        kind: "converged",
        observedRuntimeCodeHash: hash("d"),
        configurationResults: [{ id: "owner", result: "0x01" }],
      },
      checks,
    );
    const reviewed = reviewPlan(checked);

    expect(reviewed.manifest.contracts[0]).toMatchObject({ checks });
    expect(reviewed.cells[0]?.configuration).toEqual([
      {
        id: "owner",
        caller: address("1"),
        readData: "0x11111111",
        expectedResult: "0x01",
      },
    ]);
    expect(reviewed.capabilities).toEqual([]);
    expect(reviewed.steps).toEqual([]);
    expect(reviewed.requirements).toEqual([]);

    const wrongCaller = structuredClone(checked) as Mutable<PlanDraft>;
    const wrongCallerCheck = cellAt(wrongCaller, 0).configuration[0];
    if (wrongCallerCheck === undefined) throw new Error("missing external check");
    wrongCallerCheck.caller = address("2");
    expectPlanError(() => reviewPlan(wrongCaller), "manifest_mismatch", "plan.cells");

    const wrongData = structuredClone(checked) as Mutable<PlanDraft>;
    const wrongDataCheck = cellAt(wrongData, 0).configuration[0];
    if (wrongDataCheck === undefined) throw new Error("missing external check");
    wrongDataCheck.readData = "0x22222222";
    expectPlanError(() => reviewPlan(wrongData), "manifest_mismatch", "plan.cells");

    const wrongExpected = structuredClone(checked) as Mutable<PlanDraft>;
    const wrongExpectedCheck = cellAt(wrongExpected, 0).configuration[0];
    if (wrongExpectedCheck === undefined) throw new Error("missing external check");
    wrongExpectedCheck.expectedResult = "0x02";
    const wrongExpectedStatus = cellAt(wrongExpected, 0).status;
    if (wrongExpectedStatus.kind !== "converged") throw new Error("expected converged cell");
    const wrongExpectedResult = wrongExpectedStatus.configurationResults[0];
    if (wrongExpectedResult === undefined) throw new Error("missing external check result");
    wrongExpectedResult.result = "0x02";
    expectPlanError(() => reviewPlan(wrongExpected), "manifest_mismatch", "plan.cells");

    const tamperedCell = JSON.parse(JSON.stringify(reviewed)) as Mutable<typeof reviewed>;
    const tamperedCellCheck = tamperedCell.cells[0]?.configuration[0];
    if (tamperedCellCheck === undefined) throw new Error("missing serialized external check");
    tamperedCellCheck.caller = address("3");
    expectPlanError(() => parseReviewedPlan(tamperedCell), "manifest_mismatch", "plan.cells");

    const tamperedManifest = JSON.parse(JSON.stringify(reviewed)) as Mutable<typeof reviewed>;
    const tamperedResource = tamperedManifest.manifest.contracts[0];
    if (tamperedResource === undefined || tamperedResource.kind !== "external") {
      throw new Error("missing serialized external resource");
    }
    const tamperedManifestCheck = tamperedResource.checks[0];
    if (tamperedManifestCheck === undefined) throw new Error("missing manifest external check");
    tamperedManifestCheck.expectedResult = "0x02";
    expectPlanError(() => parseReviewedPlan(tamperedManifest), "manifest_mismatch", "plan.cells");
  });

  it("blocks external check drift without assigning it a remediation step", () => {
    const drifted = externalDraft(
      {
        kind: "configuration-drift",
        observedRuntimeCodeHash: hash("d"),
        mismatches: [{ id: "owner", expectedResult: "0x01", observedResult: "0x02" }],
      },
      [
        {
          id: "owner",
          caller: address("1"),
          readData: "0x11111111",
          expectedResult: "0x01",
        },
      ],
    );
    const reviewed = reviewPlan(drifted);

    expect(reviewed.disposition).toBe("blocked");
    expect(reviewed.cells[0]?.status.kind).toBe("configuration-drift");
    expect(reviewed.capabilities).toEqual([]);
    expect(reviewed.steps).toEqual([]);
    expect(reviewed.requirements).toEqual([]);

    const externalOwnedStep = structuredClone(drifted) as Mutable<PlanDraft>;
    externalOwnedStep.steps = [
      {
        id: "canonical-infrastructure:configure:owner",
        resourceId: "canonical-infrastructure",
        chainId: 1,
        kind: "configure",
        configurationId: "owner",
        drift: "configuration-drift",
        call: { target: address("a"), data: "0x22222222", value: "0" },
        postconditions: [
          {
            kind: "static-call",
            target: address("a"),
            data: "0x11111111",
            caller: address("1"),
            expectedResult: "0x01",
          },
        ],
        sender: null,
        enforcement: structuredClone(DEFAULT_PLAN_ENFORCEMENT),
      },
    ];
    expectPlanError(() => reviewPlan(externalOwnedStep), "orphan_step", "plan.steps");
  });

  it("rejects capabilities and execution steps attributed to external resources", () => {
    const unexpectedCapability = structuredClone(externalDraft()) as Mutable<PlanDraft>;
    const managedDraft = missingPlanDraft() as Mutable<PlanDraft>;
    unexpectedCapability.capabilities = [structuredClone(capabilityFor(managedDraft, 1))];
    expectPlanError(
      () => reviewPlan(unexpectedCapability),
      "unexpected_capability",
      "plan.capabilities[0]",
    );

    const externalStep = structuredClone(externalDraft()) as Mutable<PlanDraft>;
    externalStep.steps = [
      {
        ...structuredClone(stepAt(managedDraft, 0)),
        resourceId: "canonical-infrastructure",
      } as Mutable<PlanDraft["steps"][number]>,
    ];
    expectPlanError(() => reviewPlan(externalStep), "orphan_step", "plan.steps");
  });

  it("recomputes a partial mixed plan from independent managed work", () => {
    const managed = testManifest().contracts[0];
    const external = externalDraft().manifest.contracts[0];
    if (!managed || !external) throw new Error("missing mixed resource fixtures");
    const mixed = missingPlanDraft({
      manifest: { version: "moesi.manifest/v1", contracts: [external, managed] },
    });
    const reviewed = reviewPlan(mixed);

    expect(reviewed.disposition).toBe("partial");
    expect(reviewed.steps.map(({ resourceId }) => resourceId)).toEqual(["counter"]);
    expect(reviewed.capabilities).toHaveLength(1);
    expect(reviewed.requirements).toHaveLength(1);
    expect(reviewed.requirements[0]?.calls).toEqual(reviewed.steps.map(({ call }) => call));
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(reviewed)))).toEqual(reviewed);
  });

  it("rejects duplicate, unpinned, orphaned, and semantically empty steps", () => {
    const duplicate = mutableDraft();
    stepAt(duplicate, 1).chainId = stepAt(duplicate, 0).chainId;
    expectPlanError(() => reviewPlan(duplicate), "duplicate_step");

    const unpinned = mutableDraft();
    stepAt(unpinned, 0).chainId = 8453;
    expectPlanError(() => reviewPlan(unpinned), "unpinned_chain");

    const orphan = mutableDraft();
    const orphanCell = cellAt(orphan, 0);
    orphanCell.status = {
      kind: "converged",
      observedRuntimeCodeHash: hash("d"),
      configurationResults: [],
    };
    orphan.capabilities = orphan.capabilities.filter(
      ({ chainId }) => chainId !== orphanCell.chainId,
    );
    expectPlanError(() => reviewPlan(orphan), "orphan_step");

    const noSelector = mutableDraft();
    stepAt(noSelector, 0).call.data = "0x12";
    expectPlanError(() => reviewPlan(noSelector), "invalid_call");

    const noPostconditions = mutableDraft();
    stepAt(noPostconditions, 0).postconditions = [];
    expectPlanError(() => reviewPlan(noPostconditions), "invalid_postcondition");

    const tooMuchValue = mutableDraft();
    stepAt(tooMuchValue, 0).call.value = (1n << 256n).toString(10);
    expectPlanError(() => reviewPlan(tooMuchValue), "invalid_call");

    const emptyRuntime = mutableDraft();
    cellAt(emptyRuntime, 0).expectedRuntimeCodeHash = keccak256("0x");
    expectPlanError(() => reviewPlan(emptyRuntime), "invalid_cell");

    const duplicateAddress = mutableDraft();
    duplicateAddress.snapshots = [snapshotFor(duplicateAddress, 1)];
    duplicateAddress.capabilities = duplicateAddress.capabilities.filter(
      ({ chainId }) => chainId === 1,
    );
    cellAt(duplicateAddress, 0).chainId = 1;
    cellAt(duplicateAddress, 0).resourceId = "other";
    cellAt(duplicateAddress, 0).address = cellAt(duplicateAddress, 1).address;
    expectPlanError(() => reviewPlan(duplicateAddress), "duplicate_cell");
  });

  it("requires the complete resource set on every pinned chain", () => {
    const incomplete = mutableDraft();
    incomplete.cells = incomplete.cells.filter((cell) => cell.chainId === 1);
    incomplete.steps = incomplete.steps.filter((step) => step.chainId === 1);

    expectPlanError(() => reviewPlan(incomplete), "missing_cell");

    const first = testManifest({ id: "first", salt: testHash("1") }).contracts[0]!;
    const second = testManifest({ id: "second", salt: testHash("2") }).contracts[0]!;
    const omittedEverywhere = missingPlanDraft({
      manifest: { version: "moesi.manifest/v1", contracts: [first, second] },
      chainIds: [1, 10],
    }) as Mutable<PlanDraft>;
    omittedEverywhere.cells = omittedEverywhere.cells.filter(
      ({ resourceId }) => resourceId !== "second",
    );
    omittedEverywhere.steps = omittedEverywhere.steps.filter(
      ({ resourceId }) => resourceId !== "second",
    );
    expectPlanError(() => reviewPlan(omittedEverywhere), "missing_cell");
  });

  it("limits chains without treating resource cells as chains", () => {
    const resources = Array.from(
      { length: 33 },
      (_, index) =>
        testManifest({
          id: `resource-${index}`,
          salt: testHash((index + 1).toString(16).padStart(2, "0")),
        }).contracts[0]!,
    );
    const manyResources = missingPlanDraft({
      manifest: { version: "moesi.manifest/v1", contracts: resources },
    });
    expect(reviewPlan(manyResources).cells).toHaveLength(33);

    const tooManyChains = missingPlanDraft({
      chainIds: Array.from({ length: 33 }, (_, index) => index + 1),
    });
    expectPlanError(() => reviewPlan(tooManyChains), "invalid_snapshot");
  });

  it("binds deployment calls to the embedded manifest", () => {
    const wrongTarget = mutableDraft();
    stepAt(wrongTarget, 0).call.target = address("9");
    expectPlanError(() => reviewPlan(wrongTarget), "orphan_step");

    const wrongData = mutableDraft();
    stepAt(wrongData, 0).call.data = "0x12345678";
    expectPlanError(() => reviewPlan(wrongData), "orphan_step");

    const wrongValue = mutableDraft();
    stepAt(wrongValue, 0).call.value = "1";
    expectPlanError(() => reviewPlan(wrongValue), "orphan_step");
  });

  it("binds configuration writes and postcondition callers to the manifest", () => {
    const manifest = testManifest({
      configuration: [
        {
          id: "value",
          readData: "0x3fa4f245",
          expectedResult: "0x01",
          writeData: "0x5524107701",
          value: "2",
        },
      ],
      sender: { kind: "owner-eoa", address: address("7") },
    });
    const configured = missingPlanDraft({ manifest }) as Mutable<PlanDraft>;
    const cell = cellAt(configured, 0);
    const deployment = stepAt(configured, 0);
    cell.status = {
      kind: "configuration-drift",
      observedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
      mismatches: [{ id: "value", expectedResult: "0x01", observedResult: "0x00" }],
    };
    configured.capabilities = [];
    configured.steps = [
      {
        ...deployment,
        id: "counter:configure:value",
        kind: "configure",
        configurationId: "value",
        drift: "configuration-drift",
        call: { target: cell.address, data: "0x5524107701", value: "2" },
        postconditions: [
          {
            kind: "static-call",
            target: cell.address,
            data: "0x3fa4f245",
            caller: address("7"),
            expectedResult: "0x01",
          },
        ],
      },
    ];

    expect(reviewPlan(configured).steps[0]?.kind).toBe("configure");

    const wrongWrite = structuredClone(configured);
    stepAt(wrongWrite, 0).call.data = "0x5524107702";
    expectPlanError(() => reviewPlan(wrongWrite), "orphan_step");

    const wrongCaller = structuredClone(configured);
    const postcondition = stepAt(wrongCaller, 0).postconditions[0];
    if (postcondition?.kind !== "static-call") throw new Error("missing static-call test fixture");
    postcondition.caller = address("8");
    expectPlanError(() => reviewPlan(wrongCaller), "orphan_step");
  });

  it("requires every reviewed post-deployment configuration action for a missing cell", () => {
    const manifest = testManifest({
      configuration: [
        {
          id: "value",
          readData: "0x3fa4f245",
          expectedResult: "0x01",
          writeData: "0x5524107701",
          value: "0",
        },
      ],
    });
    const complete = missingPlanDraft({ manifest });
    const reviewed = reviewPlan(complete);
    expect(reviewed.steps.map(({ kind }) => kind)).toEqual(["deploy", "configure"]);
    expect(reviewed.requirements[0]?.calls).toEqual(reviewed.steps.map(({ call }) => call));

    const shuffled = structuredClone(complete) as Mutable<PlanDraft>;
    shuffled.steps.reverse();
    expect(reviewPlan(shuffled).planId).toBe(reviewed.planId);
    expect(reviewPlan(shuffled).steps.map(({ kind }) => kind)).toEqual(["deploy", "configure"]);

    const omitted = structuredClone(complete) as Mutable<PlanDraft>;
    omitted.steps = omitted.steps.filter(({ kind }) => kind === "deploy");
    expectPlanError(() => reviewPlan(omitted), "missing_step");

    const wrongDrift = structuredClone(complete) as Mutable<PlanDraft>;
    const configuration = wrongDrift.steps.find(({ kind }) => kind === "configure");
    if (!configuration) throw new Error("missing configuration fixture");
    configuration.drift = "configuration-drift";
    expectPlanError(() => reviewPlan(wrongDrift), "orphan_step");
  });

  it("orders every chain deployment before any configuration action", () => {
    const configuration = [
      {
        id: "value",
        readData: "0x11111111" as const,
        expectedResult: "0x" as const,
        writeData: "0x22222222" as const,
        value: "0",
      },
    ];
    const first = testManifest({
      id: "first",
      salt: testHash("1"),
      configuration,
    }).contracts[0]!;
    const second = testManifest({
      id: "second",
      salt: testHash("2"),
      configuration,
    }).contracts[0]!;
    const input = missingPlanDraft({
      manifest: { version: "moesi.manifest/v1", contracts: [second, first] },
      chainIds: [10, 1],
    });
    const shuffled = structuredClone(input) as Mutable<PlanDraft>;
    shuffled.steps.reverse();
    const reviewed = reviewPlan(shuffled);

    expect(reviewed.steps.map(({ chainId, id }) => `${chainId}:${id}`)).toEqual([
      "1:first:deploy",
      "1:second:deploy",
      "1:first:configure:value",
      "1:second:configure:value",
      "10:first:deploy",
      "10:second:deploy",
      "10:first:configure:value",
      "10:second:configure:value",
    ]);
    expect(reviewed.requirements.flatMap(({ calls }) => calls)).toEqual(
      reviewed.steps.map(({ call }) => call),
    );
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(reviewed)))).toEqual(reviewed);
  });

  it("rejects different senders on one chain", () => {
    const first = testManifest({
      id: "first",
      salt: testHash("1"),
      sender: { kind: "owner-eoa", address: address("1") },
    }).contracts[0]!;
    const second = testManifest({
      id: "second",
      salt: testHash("2"),
      sender: { kind: "owner-eoa", address: address("2") },
    }).contracts[0]!;
    const conflict = missingPlanDraft({
      manifest: { version: "moesi.manifest/v1", contracts: [first, second] },
    });

    expectPlanError(() => reviewPlan(conflict), "conflicting_senders");
  });
});

describe("parseReviewedPlan", () => {
  it("rebuilds the current exact artifact at a reload boundary", () => {
    const persisted = missingPlanDraft({
      manifest: testManifest({ deploymentValue: ((1n << 256n) - 1n).toString(10) }),
      firstBlockNumber: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    });
    const original = reviewPlan(persisted);
    const reloaded = parseReviewedPlan(JSON.parse(JSON.stringify(original)) as typeof original);

    expect(reloaded).toEqual(original);
    expect(reloaded).not.toBe(original);
    expect(Object.isFrozen(reloaded)).toBe(true);
    expect(reloaded.snapshots[0]?.blockNumber).toBe("9007199254740992");
    expect(reloaded.steps[0]?.call.value).toBe(((1n << 256n) - 1n).toString(10));
  });

  it("rejects payload, requirements, disposition, and version contradictions", () => {
    const payload = structuredClone(reviewPlan(draft())) as Mutable<ReturnType<typeof reviewPlan>>;
    stepAt(payload, 0).call.data = "0xffffffff";
    expectPlanError(() => parseReviewedPlan(payload), "orphan_step");

    const requirements = structuredClone(reviewPlan(draft())) as Mutable<
      ReturnType<typeof reviewPlan>
    >;
    requirementAt(requirements, 0).enforcement.operationLimit = "required";
    expectPlanError(() => parseReviewedPlan(requirements), "contradictory_plan");

    const disposition = structuredClone(reviewPlan(draft())) as Mutable<
      ReturnType<typeof reviewPlan>
    >;
    disposition.disposition = "blocked";
    expectPlanError(() => parseReviewedPlan(disposition), "contradictory_plan");

    const version = structuredClone(reviewPlan(draft())) as unknown as Record<string, unknown>;
    version.version = "moesi.reviewed-plan/v0";
    expectPlanError(() => parseReviewedPlan(version as never), "unsupported_plan_version");
  });
});
