import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  compileExecutionOperations,
  createMoesi,
  MemoryDeploymentRunStore,
  type MoesiExecutionProvider,
  type MoesiObservationAdapter,
  type ProviderExecutionEvidence,
  parseDeploymentRunRecord,
  type ReviewedPlan,
  reviewPlan,
} from "../src/index.js";
import { missingPlanDraft, testAddress, testHash, testManifest } from "./fixtures.js";

const CODE = "0x6000";
const FACTORY_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
const SENDER = testAddress("a");

function coldPlan(chains = [1]): ReviewedPlan {
  const first = testManifest({ id: "first", salt: testHash("a"), runtimeHash: keccak256(CODE) })
    .contracts[0]!;
  const second = testManifest({
    id: "second",
    salt: testHash("b"),
    runtimeHash: keccak256(CODE),
    requiresRuntime: ["first"],
    configuration: [
      {
        id: "value",
        readData: "0x12345678",
        expectedResult: "0x01",
        writeData: "0x87654321",
        value: "0",
      },
    ],
  }).contracts[0]!;
  return reviewPlan(
    missingPlanDraft({
      manifest: { version: "moesi.manifest/v6", contracts: [first, second] },
      chainIds: chains,
    }),
  );
}

function harness(plan: ReviewedPlan) {
  const store = new MemoryDeploymentRunStore();
  const deployed = new Set<number>();
  const state = { pending: false, wrongCode: false, ambiguous: false, mismatch: "" };
  const observer: MoesiObservationAdapter = {
    async captureSnapshot() {
      return { blockNumber: "100", blockHash: testHash("3") };
    },
    async readCode({ chainId, address }) {
      return address === CREATE2_FACTORY_V1_ADDRESS
        ? FACTORY_CODE
        : !deployed.has(chainId)
          ? "0x"
          : state.wrongCode
            ? "0x6001"
            : CODE;
    },
    async readCall() {
      return "0x01";
    },
    async checkBlockAncestry() {
      return true;
    },
  };
  const review = vi.fn<MoesiExecutionProvider["review"]>(async () => ({
    providerId: "atomic",
    status: "supported",
    reasons: [],
    chains: plan.requirements.map(({ chainId }) => ({
      chainId,
      sender: SENDER,
      accountId: null,
      route: "atomic-bundler",
      signer: "owner",
      signerReason: "plan-fits-one-operation",
      fallback: null,
      enforcement: {
        calls: "interactive-owner",
        expiry: "not-enforced",
        operationCount: "not-enforced",
      },
    })),
  }));
  const prepare = vi.fn<MoesiExecutionProvider["prepare"]>(async () => ({
    providerId: "atomic",
    planId: plan.planId,
    binding: null,
  }));
  const submit = vi.fn<MoesiExecutionProvider["submit"]>(async () => {
    throw new Error("unexpected single submission");
  });
  const submitBatch = vi.fn<NonNullable<MoesiExecutionProvider["submitBatch"]>>(
    async ({ operation }) => {
      const persisted = parseDeploymentRunRecord(await store.get(plan.planId));
      expect(persisted.operations.find((op) => op.chainId === operation.chainId)).toMatchObject({
        phase: "submission-requested",
        stepIds: operation.steps.map((step) => step.id),
      });
      deployed.add(operation.chainId);
      if (state.ambiguous) throw new Error("ambiguous send");
      return {
        providerId: "atomic",
        chainId: operation.chainId,
        reference: `operation-${operation.chainId}`,
      };
    },
  );
  const observe = vi.fn<MoesiExecutionProvider["observe"]>(
    async ({ reference }): Promise<ProviderExecutionEvidence> => {
      if (state.pending) return { status: "pending" };
      const calls = plan.steps
        .filter((step) => step.chainId === reference.chainId)
        .map((step) => step.call);
      if (state.mismatch === "missing") calls.pop();
      if (state.mismatch === "reordered") calls.reverse();
      if (state.mismatch === "duplicate") calls[1] = calls[0]!;
      if (state.mismatch === "value") calls[0] = { ...calls[0]!, value: "1" };
      if (state.mismatch === "reverted") return { status: "failed", reason: "reverted" };
      return {
        status: "finalized",
        finalized: {
          chainId: reference.chainId,
          sender: state.mismatch === "sender" ? testAddress("b") : SENDER,
          calls,
          providerEvidenceId: testHash("8"),
          submissionRoute: "transaction",
          blockNumber: "10",
          blockHash: testHash("2"),
        },
      };
    },
  );
  const provider: MoesiExecutionProvider = {
    id: "atomic",
    review,
    prepare,
    submit,
    submitBatch,
    observe,
  };
  const moesi = createMoesi({ observer, runStore: store });
  async function start() {
    const executionReview = await moesi.reviewExecution({ plan, provider });
    expect(executionReview.packing).toBe("per-chain");
    return moesi.apply({
      plan,
      provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
  }
  return {
    plan,
    provider,
    review,
    prepare,
    submit,
    submitBatch,
    observe,
    observer,
    store,
    moesi,
    state,
    start,
  };
}

describe("atomic per-chain operations", () => {
  it.each([false, true])("skips only when every call is satisfied (all=%s)", async (all) => {
    const manifest = coldPlan().manifest;
    const configured = {
      ...manifest,
      contracts: manifest.contracts.map((resource) => ({
        ...resource,
        configuration: [
          {
            id: "value",
            readData: "0x12345678" as const,
            expectedResult: "0x01" as const,
            writeData: "0x87654321" as const,
            value: "0",
          },
        ],
      })),
    };
    const satisfied = new Set<string>();
    const observer: MoesiObservationAdapter = {
      async captureSnapshot() {
        return { blockNumber: "1", blockHash: testHash("1") };
      },
      async readCode({ address }) {
        return address === CREATE2_FACTORY_V1_ADDRESS ? FACTORY_CODE : CODE;
      },
      async readCall({ target }) {
        return satisfied.has(target) ? "0x01" : "0x00";
      },
      async checkBlockAncestry() {
        return true;
      },
    };
    const plan = await createMoesi({ observer }).plan({ manifest: configured, chains: [1] });
    expect(plan.steps.map((step) => step.kind)).toEqual(["configure", "configure"]);
    satisfied.add(plan.steps[0]!.call.target);
    if (all) satisfied.add(plan.steps[1]!.call.target);
    const h = harness(plan);
    const client = createMoesi({
      observer: { ...observer, captureSnapshot: h.observer.captureSnapshot },
      runStore: h.store,
    });
    const executionReview = await client.reviewExecution({ plan, provider: h.provider });
    await client.apply({ plan, provider: h.provider, executionReview }).wait();
    if (all) {
      expect(h.submitBatch).not.toHaveBeenCalled();
      expect(parseDeploymentRunRecord(await h.store.get(plan.planId)).operations).toMatchObject([
        { phase: "satisfied" },
      ]);
    } else {
      expect(h.submitBatch).toHaveBeenCalledOnce();
      expect(h.submitBatch.mock.calls[0]![0].operation.steps).toEqual(plan.steps);
    }
  });

  it("packs exact ordered calls, including cold runtime dependencies and configuration", async () => {
    const h = harness(coldPlan([1, 2]));
    const operations = compileExecutionOperations(h.plan, "per-chain");
    expect(operations.map((op) => op.steps.length)).toEqual([3, 3]);
    expect(Object.isFrozen(operations[0]!.steps)).toBe(true);
    const result = await (await h.start()).wait();
    expect(result.status).toBe("converged");
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.submitBatch.mock.calls.map(([input]) => input.operation)).toEqual(operations);
    expect(h.review).toHaveBeenCalledWith({ plan: h.plan, packing: "per-chain" });
    const record = parseDeploymentRunRecord(await h.store.get(h.plan.planId));
    expect(record.operations).toHaveLength(2);
    expect(record.operations.map((op) => op.phase)).toEqual(["finalized", "finalized"]);
    expect(record.revision).toBe(6);
    expect(result.chains[0]!.execution).toMatchObject({
      operations: [
        { operationId: "chain-1", stepIds: operations[0]!.steps.map((step) => step.id) },
      ],
    });
  });

  it.each(["missing", "reordered", "duplicate", "value", "sender"])(
    "rejects %s batch evidence and never resends",
    async (mismatch) => {
      const h = harness(coldPlan());
      h.state.mismatch = mismatch;
      const run = await h.start();
      expect((await run.wait()).chains[0]!.execution).toMatchObject({
        kind: "failed",
        reason: "call-mismatch",
      });
      const resumed = await h.moesi.resume({ runId: run.runId, provider: h.provider });
      expect((await resumed.wait()).chains[0]!.execution).toMatchObject({
        kind: "failed",
        reason: "call-mismatch",
      });
      expect(h.submitBatch).toHaveBeenCalledOnce();
    },
  );

  it("does not confuse complete provider evidence with runtime convergence", async () => {
    const h = harness(coldPlan());
    h.state.wrongCode = true;
    const result = await (await h.start()).wait();
    expect(result.chains[0]!.execution.kind).toBe("finalized");
    expect(result.chains[0]!.status).toBe("drifted");
  });

  it("recovers a retained batch reference with observation alone", async () => {
    const h = harness(coldPlan());
    h.state.pending = true;
    const run = await h.start();
    await run.wait();
    const retained = parseDeploymentRunRecord(await h.store.get(run.runId)).operations[0]!;
    expect(retained.phase).toBe("submitted");
    h.state.pending = false;
    h.review.mockClear();
    h.prepare.mockClear();
    h.submitBatch.mockClear();
    const { submitBatch: _batch, ...observationProvider } = h.provider;
    const resumed = await h.moesi.resume({ runId: run.runId, provider: observationProvider });
    expect((await resumed.wait()).status).toBe("converged");
    expect(h.review).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.submitBatch).not.toHaveBeenCalled();
    if (retained.phase !== "submitted") throw new Error("missing reference");
    expect(h.observe).toHaveBeenLastCalledWith({ reference: retained.reference });
  });

  it("keeps an ambiguous whole-batch fence after process loss", async () => {
    const h = harness(coldPlan());
    h.state.ambiguous = true;
    const run = await h.start();
    await run.wait();
    const resumed = await h.moesi.resume({ runId: run.runId, provider: h.provider });
    expect((await resumed.wait()).chains[0]!.execution).toMatchObject({
      kind: "failed",
      reason: "submission-ambiguous",
      operations: [],
    });
    expect(h.submitBatch).toHaveBeenCalledOnce();
    expect(h.observe).not.toHaveBeenCalled();
  });

  it("retains a reverted batch as one failed operation", async () => {
    const h = harness(coldPlan());
    h.state.mismatch = "reverted";
    const run = await h.start();
    expect((await run.wait()).chains[0]!.execution).toMatchObject({
      kind: "failed",
      reason: "execution-failed",
    });
    const resumed = await h.moesi.resume({ runId: run.runId, provider: h.provider });
    await resumed.wait();
    expect(h.submitBatch).toHaveBeenCalledOnce();
  });

  it("rejects a changed packing, changed batch membership, and stale durable schemas", async () => {
    const h = harness(coldPlan());
    const run = await h.start();
    run.requestStop();
    await run.wait();
    const record = parseDeploymentRunRecord(await h.store.get(run.runId));
    for (const candidate of [
      { ...record, operations: [{ ...record.operations[0], phase: "satisfied" }] },
      { ...record, operations: [{ ...record.operations[0], stepIds: Array(3) }] },
      { ...record, executionReview: { ...record.executionReview, packing: "per-step" } },
      { ...record, operations: [{ ...record.operations[0], stepIds: ["first:deploy"] }] },
      {
        ...record,
        operations: [
          { ...record.operations[0], stepIds: [...record.operations[0]!.stepIds].reverse() },
        ],
      },
    ])
      expect(() => parseDeploymentRunRecord(candidate)).toThrow();
    expect(() =>
      parseDeploymentRunRecord({ ...record, version: "moesi.deployment-run/v7" }),
    ).toThrow(expect.objectContaining({ code: "unsupported_run_version" }));
    for (const packing of [null, "batch", 1]) {
      await expect(
        h.moesi.reviewExecution({ plan: h.plan, provider: h.provider, packing: packing as never }),
      ).rejects.toMatchObject({ code: "invalid_execution_packing" });
    }
    const { submitBatch: _batch, ...singleProvider } = h.provider;
    await expect(
      h.moesi.reviewExecution({ plan: h.plan, provider: singleProvider, packing: "per-chain" }),
    ).rejects.toMatchObject({ code: "provider_packing_unsupported" });
    const resumed = await h.moesi.resume({ runId: run.runId, provider: singleProvider });
    await expect(resumed.wait()).rejects.toMatchObject({ code: "provider_packing_unsupported" });
    expect(h.submit).not.toHaveBeenCalled();
  });
});
