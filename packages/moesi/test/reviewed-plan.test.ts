import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { PlanDraft } from "../src/index.js";
import {
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
    expect(plan.steps[0]?.call.target).toBe(address("a"));
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
    const reads = { snapshots: 0, cells: 0, steps: 0 };
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
    expect(plan.cells).toHaveLength(2);
    expect(plan.steps).toHaveLength(2);
    expect(reads).toEqual({ snapshots: 1, cells: 1, steps: 1 });
  });

  it("rejects caller-supplied requirements instead of accepting two sources of truth", () => {
    const adversarial = { ...draft(), requirements: [] } as unknown as PlanDraft;
    expectPlanError(() => reviewPlan(adversarial), "unknown_field", "plan.requirements");
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

  it("rejects duplicate, unpinned, orphaned, and semantically empty steps", () => {
    const duplicate = mutableDraft();
    stepAt(duplicate, 1).chainId = stepAt(duplicate, 0).chainId;
    expectPlanError(() => reviewPlan(duplicate), "duplicate_step");

    const unpinned = mutableDraft();
    stepAt(unpinned, 0).chainId = 8453;
    expectPlanError(() => reviewPlan(unpinned), "unpinned_chain");

    const orphan = mutableDraft();
    cellAt(orphan, 0).status = {
      kind: "converged",
      observedRuntimeCodeHash: hash("d"),
      configurationResults: [],
    };
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
