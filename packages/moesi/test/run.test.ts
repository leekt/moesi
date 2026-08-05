import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type {
  MoesiExecutionProvider,
  MoesiObservationAdapter,
  ReviewedPlan,
  ReviewedPlanAction,
} from "../src/index.js";
import { createMoesi, reviewPlan, verifyChainConvergence } from "../src/index.js";
import { missingPlanDraft, testManifest } from "./fixtures.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const CODE = "0x6000" as const;
const SENDER = address("a");

function plan(chainIds: readonly number[] = [1]): ReviewedPlan {
  return reviewPlan(
    missingPlanDraft({ manifest: testManifest({ runtimeHash: keccak256(CODE) }), chainIds }),
  );
}

function twoStepPlan(): ReviewedPlan {
  const first = testManifest({ id: "first", salt: hash("a"), runtimeHash: keccak256(CODE) })
    .contracts[0]!;
  const second = testManifest({ id: "second", salt: hash("b"), runtimeHash: keccak256(CODE) })
    .contracts[0]!;
  return reviewPlan(
    missingPlanDraft({
      manifest: { version: "moesi.manifest/v1", contracts: [first, second] },
    }),
  );
}

function observer(): MoesiObservationAdapter {
  return {
    async captureSnapshot(chainId) {
      return {
        blockNumber: (100n + BigInt(chainId)).toString(10),
        blockHash: hash(chainId === 1 ? "3" : "4"),
      };
    },
    async readCode() {
      return CODE;
    },
    async readCall() {
      return "0x";
    },
    async checkBlockAncestry() {
      return true;
    },
  };
}

function finalized(action: ReviewedPlanAction, sender = SENDER) {
  return {
    status: "finalized" as const,
    finalized: {
      chainId: action.chainId,
      sender,
      calls: [action.step.call],
      providerEvidenceId: hash(action.chainId === 1 ? "8" : "9"),
      blockNumber: (BigInt(action.chainId) + 10n).toString(10),
      blockHash: hash(action.chainId === 1 ? "6" : "7"),
    },
  };
}

function runProvider(
  input: {
    readonly submit?: (action: ReviewedPlanAction) => Promise<string>;
    readonly observe?: (
      action: ReviewedPlanAction,
      attempt: number,
    ) => Promise<
      | ReturnType<typeof finalized>
      | { status: "pending" }
      | {
          status: "unreadable";
          reason: "observation-unavailable";
        }
    >;
  } = {},
): {
  readonly provider: MoesiExecutionProvider;
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly submit: ReturnType<typeof vi.fn>;
  readonly observe: ReturnType<typeof vi.fn>;
} {
  const actions = new Map<string, ReviewedPlanAction>();
  const attempts = new Map<string, number>();
  const submit = vi.fn(async ({ action }: Parameters<MoesiExecutionProvider["submit"]>[0]) => {
    const reference = input.submit
      ? await input.submit(action)
      : hash(action.chainId === 1 ? "8" : "9");
    actions.set(reference, action);
    return { providerId: "fake", chainId: action.chainId, reference };
  });
  const observe = vi.fn(async ({ reference }: Parameters<MoesiExecutionProvider["observe"]>[0]) => {
    const action = actions.get(reference.reference);
    if (!action)
      return { status: "unreadable" as const, reason: "observation-unavailable" as const };
    const attempt = (attempts.get(reference.reference) ?? 0) + 1;
    attempts.set(reference.reference, attempt);
    return input.observe ? input.observe(action, attempt) : finalized(action);
  });
  const prepare = vi.fn(
    async ({ plan: reviewed }: Parameters<MoesiExecutionProvider["prepare"]>[0]) => ({
      providerId: "fake",
      planId: reviewed.planId,
      binding: {},
    }),
  );
  return {
    prepare,
    submit,
    observe,
    provider: Object.freeze({
      id: "fake",
      async review({ plan: reviewed }: Parameters<MoesiExecutionProvider["review"]>[0]) {
        return {
          providerId: "fake",
          status: "supported" as const,
          chains: reviewed.requirements.map(({ chainId }) => ({
            chainId,
            sender: SENDER,
            accountId: null,
            route: "fake-direct",
            enforcement: {
              calls: "interactive-owner" as const,
              expiry: "not-enforced" as const,
              operationCount: "not-enforced" as const,
            },
          })),
          reasons: [],
        };
      },
      prepare,
      submit,
      observe,
    }),
  };
}

describe("DeploymentRun", () => {
  it("retries observation of one reference without another submission", async () => {
    const selected = runProvider({
      async observe(action, attempt) {
        if (attempt === 1) {
          return { status: "unreadable", reason: "observation-unavailable" };
        }
        return finalized(action);
      },
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer() });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = moesi.apply({
      plan: reviewed,
      provider: selected.provider,
      executionReview,
      observeTiming: { attempts: 2, delayMs: 0 },
    });

    const result = await run.wait();
    expect(result.status).toBe("converged");
    expect(selected.submit).toHaveBeenCalledTimes(1);
    expect(selected.observe).toHaveBeenCalledTimes(2);
    expect(selected.observe.mock.calls[0]?.[0]).toEqual(selected.observe.mock.calls[1]?.[0]);
  });

  it("lets independent chains converge or fail without borrowing evidence", async () => {
    const selected = runProvider({
      async submit(action) {
        if (action.chainId === 10) throw new Error("chain unavailable");
        return hash("8");
      },
    });
    const reviewed = plan([10, 1]);
    const moesi = createMoesi({ observer: observer() });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected.provider,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(result.status).toBe("partial");
    expect(result.chains.map(({ chainId, status }) => [chainId, status])).toEqual([
      [1, "converged"],
      [10, "execution-failed"],
    ]);
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "finalized",
      steps: [{ reference: { chainId: 1, reference: hash("8") } }],
    });
    expect(result.chains[1]?.execution).toEqual({
      kind: "failed",
      providerId: "fake",
      reason: "execution-failed",
      steps: [],
    });
  });

  it("retains finalized provider evidence when its sender contradicts review", async () => {
    const selected = runProvider({
      async observe(action) {
        return finalized(action, address("b"));
      },
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer() });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected.provider,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "call-mismatch",
      steps: [
        {
          reference: { reference: hash("8") },
          providerEvidence: { sender: address("b") },
        },
      ],
    });
  });

  it("refuses convergence from a snapshot captured before finalized execution", async () => {
    const selected = runProvider();
    const reviewed = plan();
    const staleObserver: MoesiObservationAdapter = {
      ...observer(),
      async captureSnapshot() {
        return { blockNumber: "5", blockHash: hash("5") };
      },
    };
    const moesi = createMoesi({ observer: staleObserver });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected.provider,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(result.chains[0]?.status).toBe("unreadable");
    expect(result.chains[0]?.cells[0]?.status).toEqual({
      kind: "unreadable",
      reason: "snapshot-before-execution",
    });
  });

  it("rejects one provider operation reused for two reviewed actions", async () => {
    const selected = runProvider();
    const reviewed = twoStepPlan();
    const moesi = createMoesi({ observer: observer() });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected.provider,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(selected.submit).toHaveBeenCalledTimes(2);
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "invalid-evidence",
      steps: [{ stepId: "first:deploy" }, { stepId: "second:deploy" }],
    });
  });

  it("rejects execution evidence that moves backward in chain history", async () => {
    const selected = runProvider({
      async submit(action) {
        return hash(action.step.resourceId === "first" ? "8" : "9");
      },
      async observe(action) {
        const first = action.step.resourceId === "first";
        return {
          status: "finalized",
          finalized: {
            ...finalized(action).finalized,
            providerEvidenceId: hash(first ? "8" : "9"),
            blockNumber: first ? "20" : "19",
            blockHash: hash(first ? "6" : "7"),
          },
        };
      },
    });
    const reviewed = twoStepPlan();
    const moesi = createMoesi({ observer: observer() });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected.provider,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "invalid-evidence",
    });
  });

  it("requires each sequential action to finalize in a later block", async () => {
    const selected = runProvider({
      async submit(action) {
        return hash(action.step.resourceId === "first" ? "8" : "9");
      },
      async observe(action) {
        const first = action.step.resourceId === "first";
        return {
          status: "finalized",
          finalized: {
            ...finalized(action).finalized,
            providerEvidenceId: hash(first ? "8" : "9"),
            blockNumber: "20",
            blockHash: hash(first ? "6" : "7"),
          },
        };
      },
    });
    const reviewed = twoStepPlan();
    const moesi = createMoesi({ observer: observer() });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected.provider,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "invalid-evidence",
    });
  });

  it("checks planning-snapshot lineage before provider preparation or submission", async () => {
    const selected = runProvider();
    const reviewed = plan();
    const staleObserver: MoesiObservationAdapter = {
      ...observer(),
      async checkBlockAncestry() {
        return false;
      },
    };
    const moesi = createMoesi({ observer: staleObserver });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = moesi.apply({ plan: reviewed, provider: selected.provider, executionReview });

    await expect(run.wait()).rejects.toMatchObject({ code: "plan_snapshot_unverifiable" });
    expect(selected.prepare).not.toHaveBeenCalled();
    expect(selected.submit).not.toHaveBeenCalled();
  });

  it("requires the convergence snapshot to descend from execution evidence", async () => {
    const selected = runProvider();
    const reviewed = plan();
    const ancestryObserver: MoesiObservationAdapter = {
      ...observer(),
      async captureSnapshot() {
        return { blockNumber: "11", blockHash: hash("5") };
      },
      async checkBlockAncestry({ ancestor }) {
        return ancestor.blockHash !== hash("6");
      },
    };
    const moesi = createMoesi({ observer: ancestryObserver });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected.provider,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(selected.submit).toHaveBeenCalledTimes(1);
    expect(result.chains[0]?.status).toBe("unreadable");
    expect(result.chains[0]?.cells[0]?.status).toEqual({
      kind: "unreadable",
      reason: "snapshot-not-descendant",
    });
  });

  it("never reports convergence for a chain absent from the plan", async () => {
    const captureSnapshot = vi.fn();
    const result = await verifyChainConvergence({
      plan: plan(),
      chainId: 10,
      executionAncestors: [],
      observer: { ...observer(), captureSnapshot },
    });

    expect(result).toEqual({ status: "unreadable", snapshot: null, cells: [] });
    expect(captureSnapshot).not.toHaveBeenCalled();
  });
});
