import { describe, expect, it } from "vitest";
import type { PlanDraft } from "../src/index.js";
import { MoesiPlanError, parseReviewedPlan, reviewPlan } from "../src/index.js";

const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const address = (byte: string) => `0x${byte.repeat(40)}` as const;

function draft(): PlanDraft {
  return {
    manifestHash: hash("a"),
    snapshots: [
      { chainId: 10, blockNumber: 20n, blockHash: hash("b") },
      { chainId: 1, blockNumber: 10n, blockHash: hash("c") },
    ],
    cells: [
      {
        resourceId: "counter.deploy",
        chainId: 10,
        address: address("e"),
        expectedRuntimeCodeHash: hash("e"),
        configuration: [],
        status: { kind: "missing" },
      },
      {
        resourceId: "counter.deploy",
        chainId: 1,
        address: address("d"),
        expectedRuntimeCodeHash: hash("d"),
        configuration: [],
        status: { kind: "missing" },
      },
    ],
    steps: [
      {
        id: "counter.deploy:deploy",
        resourceId: "counter.deploy",
        chainId: 1,
        kind: "deploy",
        configurationId: null,
        drift: "missing",
        call: { target: address("A"), data: "0x1234567801", value: 0n },
        postconditions: [
          { kind: "runtime-code-hash", address: address("D"), expectedHash: hash("d") },
        ],
      },
      {
        id: "counter.deploy:deploy",
        resourceId: "counter.deploy",
        chainId: 10,
        kind: "deploy",
        configurationId: null,
        drift: "missing",
        call: { target: address("a"), data: "0x1234567801", value: 0n },
        postconditions: [
          { kind: "runtime-code-hash", address: address("e"), expectedHash: hash("e") },
        ],
      },
    ],
  };
}

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function mutableDraft(): Mutable<PlanDraft> {
  return draft() as Mutable<PlanDraft>;
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
  const snapshot = plan.snapshots.find((entry) => entry.chainId === chainId);
  if (!snapshot) throw new Error(`missing test snapshot ${chainId}`);
  return snapshot;
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
  it("owns normalized calls and derives one exact all-chain policy", () => {
    const plan = reviewPlan(draft());

    expect(plan.version).toBe("moesi.reviewed-plan/v1");
    expect(plan.disposition).toBe("changes");
    expect(plan.snapshots.map(({ chainId }) => chainId)).toEqual([1, 10]);
    expect(plan.cells.map(({ chainId }) => chainId)).toEqual([1, 10]);
    expect(plan.steps[0]?.call.target).toBe(address("a"));
    expect(plan.policy).toEqual({
      chainScope: "all",
      calls: [
        {
          target: address("a"),
          selector: "0x12345678",
          calldata: "0x1234567801",
          value: 0n,
        },
      ],
      perChainOperationLimit: 1,
    });
    expect(plan.planId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces the same identity for semantically identical boundary input", () => {
    const left = mutableDraft();
    const right = mutableDraft();
    right.snapshots.reverse();

    expect(reviewPlan(left).planId).toBe(reviewPlan(right).planId);
  });

  it("deep-freezes the reviewed artifact instead of retaining caller objects", () => {
    const input = mutableDraft();
    const plan = reviewPlan(input);
    stepAt(input, 0).call.data = "0xffffffff";

    expect(plan.steps[0]?.call.data).toBe("0x1234567801");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps)).toBe(true);
    expect(Object.isFrozen(plan.steps[0]?.call)).toBe(true);
    expect(() => {
      (plan.policy.calls as ReviewedCallScopeForMutation[]).push({
        target: address("f"),
        selector: "0xffffffff",
        calldata: "0xffffffff",
        value: 0n,
      });
    }).toThrow(TypeError);
  });

  it("rejects a caller-supplied policy instead of accepting two sources of truth", () => {
    const adversarial = { ...draft(), policy: { chainScope: "all" } } as unknown as PlanDraft;
    expectPlanError(() => reviewPlan(adversarial), "unknown_field", "plan.policy");
  });

  it("represents converged and blocked desired state without fabricating calls", () => {
    const converged = mutableDraft();
    converged.cells = [
      {
        resourceId: "counter.deploy",
        chainId: 1,
        address: address("d"),
        expectedRuntimeCodeHash: hash("d"),
        configuration: [],
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
    expect(convergedPlan.policy.calls).toEqual([]);
    expect(convergedPlan.policy.perChainOperationLimit).toBe(0);

    const blocked = mutableDraft();
    blocked.cells = [
      {
        resourceId: "counter.deploy",
        chainId: 1,
        address: address("d"),
        expectedRuntimeCodeHash: hash("d"),
        configuration: [],
        status: {
          kind: "bytecode-drift",
          observedRuntimeCodeHash: hash("f"),
        },
      },
    ];
    blocked.snapshots = [snapshotFor(blocked, 1)];
    blocked.steps = [];
    expect(reviewPlan(blocked).disposition).toBe("blocked");
  });

  it("marks independently actionable cells as partial when another cell is blocked", () => {
    const partial = mutableDraft();
    cellAt(partial, 0).status = {
      kind: "unreadable",
      reason: "read-failed",
      configurationId: null,
    };
    partial.steps = [stepAt(partial, 0)];

    expect(reviewPlan(partial).disposition).toBe("partial");
  });

  it("rejects duplicate steps and steps without pinned observation", () => {
    const duplicate = mutableDraft();
    stepAt(duplicate, 1).chainId = stepAt(duplicate, 0).chainId;
    stepAt(duplicate, 1).id = stepAt(duplicate, 0).id;
    expectPlanError(() => reviewPlan(duplicate), "duplicate_step");

    const unpinned = mutableDraft();
    stepAt(unpinned, 0).chainId = 8453;
    expectPlanError(() => reviewPlan(unpinned), "unpinned_chain");
  });

  it("rejects steps that do not belong to missing-cell evidence", () => {
    const orphan = mutableDraft();
    cellAt(orphan, 0).status = {
      kind: "converged",
      observedRuntimeCodeHash: hash("e"),
      configurationResults: [],
    };
    expectPlanError(() => reviewPlan(orphan), "orphan_step");

    const missing = mutableDraft();
    missing.steps = [stepAt(missing, 0)];
    expectPlanError(() => reviewPlan(missing), "missing_step");
  });

  it("rejects calls without a selector and plans without semantic postconditions", () => {
    const noSelector = mutableDraft();
    stepAt(noSelector, 0).call.data = "0x12";
    expectPlanError(() => reviewPlan(noSelector), "invalid_call");

    const noPostconditions = mutableDraft();
    stepAt(noPostconditions, 0).postconditions = [];
    expectPlanError(() => reviewPlan(noPostconditions), "invalid_postcondition");
  });

  it("accepts only configuration steps justified by exact mismatch evidence", () => {
    const configured = mutableDraft();
    configured.snapshots = [snapshotFor(configured, 1)];
    configured.cells = [
      {
        resourceId: "counter.deploy",
        chainId: 1,
        address: address("d"),
        expectedRuntimeCodeHash: hash("d"),
        configuration: [{ id: "owner", readData: "0x12345678", expectedResult: "0x01" }],
        status: {
          kind: "configuration-drift",
          observedRuntimeCodeHash: hash("d"),
          mismatches: [{ id: "owner", expectedResult: "0x01", observedResult: "0x00" }],
        },
      },
    ];
    configured.steps = [
      {
        id: "counter.deploy:configure:owner",
        resourceId: "counter.deploy",
        chainId: 1,
        kind: "configure",
        configurationId: "owner",
        drift: "configuration-drift",
        call: { target: address("d"), data: "0x87654321", value: 0n },
        postconditions: [
          {
            kind: "static-call",
            target: address("d"),
            data: "0x12345678",
            expectedResult: "0x01",
          },
        ],
      },
    ];
    expect(reviewPlan(configured).disposition).toBe("changes");

    const tampered = structuredClone(configured);
    const postcondition = stepAt(tampered, 0).postconditions[0];
    if (postcondition?.kind !== "static-call") throw new Error("missing static-call postcondition");
    postcondition.expectedResult = "0x02";
    expectPlanError(() => reviewPlan(tampered), "orphan_step");
  });
});

describe("parseReviewedPlan", () => {
  it("rebuilds the current exact artifact at a reload boundary", () => {
    const original = reviewPlan(draft());
    const reloaded = parseReviewedPlan(structuredClone(original) as typeof original);

    expect(reloaded).toEqual(original);
    expect(reloaded).not.toBe(original);
    expect(Object.isFrozen(reloaded)).toBe(true);
  });

  it("rejects payload, policy, disposition, and version contradictions", () => {
    const payload = structuredClone(reviewPlan(draft())) as Mutable<ReturnType<typeof reviewPlan>>;
    stepAt(payload, 0).call.data = "0xffffffff";
    expectPlanError(() => parseReviewedPlan(payload), "plan_identity_mismatch");

    const policy = structuredClone(reviewPlan(draft())) as Mutable<ReturnType<typeof reviewPlan>>;
    policy.policy.perChainOperationLimit = 99;
    expectPlanError(() => parseReviewedPlan(policy), "contradictory_plan");

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

interface ReviewedCallScopeForMutation {
  target: `0x${string}`;
  selector: `0x${string}`;
  calldata: `0x${string}`;
  value: bigint;
}
