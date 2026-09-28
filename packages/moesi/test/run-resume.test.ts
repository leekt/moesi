import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type {
  DeploymentRun,
  MoesiExecutionProvider,
  MoesiObservationAdapter,
  ProviderExecutionReference,
  ReviewedPlan,
  ReviewedPlanAction,
} from "../src/index.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  createMoesi,
  MemoryDeploymentRunStore,
  MoesiRunError,
  parseDeploymentRunRecord,
  reviewPlan,
} from "../src/index.js";
import { missingPlanDraft, testManifest } from "./fixtures.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const CODE = "0x6000" as const;
const FACTORY_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as const;
const SENDER = address("a");

function plan(): ReviewedPlan {
  return reviewPlan(missingPlanDraft({ manifest: testManifest({ runtimeHash: keccak256(CODE) }) }));
}

function twoStepPlan(): ReviewedPlan {
  const first = testManifest({ id: "first", salt: hash("a"), runtimeHash: keccak256(CODE) })
    .contracts[0]!;
  const second = testManifest({ id: "second", salt: hash("b"), runtimeHash: keccak256(CODE) })
    .contracts[0]!;
  return reviewPlan(
    missingPlanDraft({
      manifest: { version: "moesi.manifest/v4", contracts: [first, second] },
    }),
  );
}

function observer(): MoesiObservationAdapter {
  return {
    async captureSnapshot() {
      return { blockNumber: "100", blockHash: hash("3") };
    },
    async readCode({ address: target }) {
      return target === CREATE2_FACTORY_V1_ADDRESS ? FACTORY_CODE : CODE;
    },
    async readCall() {
      return "0x";
    },
    async checkBlockAncestry() {
      return true;
    },
  };
}

function finalized(reviewed: ReviewedPlan, stepIndex = 0, evidenceByte = "8", blockNumber = "10") {
  return {
    status: "finalized" as const,
    finalized: {
      chainId: 1,
      sender: SENDER,
      calls: [reviewed.steps[stepIndex]!.call],
      providerEvidenceId: hash(evidenceByte),
      blockNumber,
      blockHash: hash("6"),
    },
  };
}

function provider(input: {
  readonly reviewed: ReviewedPlan;
  readonly id?: string;
  readonly submit?: (action: ReviewedPlanAction) => Promise<string>;
  readonly observe?: (
    reference: ProviderExecutionReference,
  ) => Promise<ReturnType<typeof finalized> | { readonly status: "pending" }>;
}): {
  readonly provider: MoesiExecutionProvider;
  readonly review: ReturnType<typeof vi.fn>;
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly submit: ReturnType<typeof vi.fn>;
  readonly observe: ReturnType<typeof vi.fn>;
} {
  const id = input.id ?? "fake";
  const review = vi.fn(async () => ({
    providerId: id,
    status: "supported" as const,
    chains: [
      {
        chainId: 1,
        sender: SENDER,
        accountId: null,
        route: "fake-direct",
        enforcement: {
          calls: "interactive-owner" as const,
          expiry: "not-enforced" as const,
          operationCount: "not-enforced" as const,
        },
      },
    ],
    reasons: [],
  }));
  const prepare = vi.fn(async () => ({
    providerId: id,
    planId: input.reviewed.planId,
    binding: {},
  }));
  const submit = vi.fn(async ({ action }: Parameters<MoesiExecutionProvider["submit"]>[0]) => ({
    providerId: id,
    chainId: action.chainId,
    reference: input.submit ? await input.submit(action) : hash("8"),
  }));
  const observe = vi.fn(async ({ reference }: Parameters<MoesiExecutionProvider["observe"]>[0]) =>
    input.observe ? input.observe(reference) : finalized(input.reviewed),
  );
  return {
    review,
    prepare,
    submit,
    observe,
    provider: Object.freeze({ id, review, prepare, submit, observe }),
  };
}

describe("durable DeploymentRun recovery", () => {
  it("persists the possible-submission fence before calling the provider", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    let runId = "";
    const selected = provider({
      reviewed,
      async submit() {
        const record = parseDeploymentRunRecord(await store.get(runId));
        expect(record.steps[0]?.phase).toBe("submission-requested");
        return hash("8");
      },
    });
    const moesi = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await moesi.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = moesi.apply({
      plan: reviewed,
      provider: selected.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    runId = run.runId;
    expect(run.runId).toBe(reviewed.planId);

    await expect(run.wait()).resolves.toMatchObject({ status: "converged" });
    expect(selected.submit).toHaveBeenCalledTimes(1);
  });

  it("rechecks the canonical factory before fencing a pending deployment on resume", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const original = provider({ reviewed });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
    });
    firstRun.requestStop();
    await firstRun.wait();
    expect(original.submit).not.toHaveBeenCalled();

    const recovered = provider({ reviewed });
    const resumed = await createMoesi({
      observer: {
        ...observer(),
        async readCode() {
          return "0x6001";
        },
      },
      runStore: store,
    }).resume({ runId: firstRun.runId, provider: recovered.provider });

    const result = await resumed.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-capability-mismatch",
      steps: [],
    });
    expect(recovered.prepare).toHaveBeenCalledOnce();
    expect(recovered.submit).not.toHaveBeenCalled();
    expect(parseDeploymentRunRecord(await store.get(firstRun.runId)).steps[0]).toMatchObject({
      phase: "pending",
    });
  });

  it("recreates a run and observes its exact reference without review, prepare, or submit", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const original = provider({
      reviewed,
      async observe() {
        return { status: "pending" };
      },
    });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await firstRun.wait();
    expect(firstRun.state).toBe("recovery-required");

    const recovered = provider({ reviewed });
    const recreatedClient = createMoesi({ observer: observer(), runStore: store });
    const resumed = await recreatedClient.resume({
      runId: firstRun.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    const result = await resumed.wait();

    expect(result.status).toBe("converged");
    expect(resumed.state).toBe("complete");
    expect(recovered.review).not.toHaveBeenCalled();
    expect(recovered.prepare).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
    expect(recovered.observe).toHaveBeenCalledTimes(1);
    expect(recovered.observe).toHaveBeenCalledWith({
      reference: { providerId: "fake", chainId: 1, reference: hash("8") },
    });
  });

  it("preserves a fully finalized run when recovery is stopped before wait", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const original = provider({ reviewed });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
    });
    await firstRun.wait();

    const recovered = provider({ reviewed });
    const resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: firstRun.runId,
      provider: recovered.provider,
    });
    resumed.requestStop();
    const result = await resumed.wait();

    expect(result.status).toBe("converged");
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "finalized",
      steps: [{ reference: { reference: hash("8") } }],
    });
    expect(recovered.observe).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
  });

  it("retains a submitted reference when stopped before resumed observation", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const original = provider({
      reviewed,
      async observe() {
        return { status: "pending" };
      },
    });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await firstRun.wait();

    const recovered = provider({ reviewed });
    const resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: firstRun.runId,
      provider: recovered.provider,
    });
    resumed.requestStop();
    const result = await resumed.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "stop-requested",
      steps: [{ reference: { reference: hash("8") }, providerEvidence: null }],
    });
    expect(recovered.observe).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
  });

  it("does not let stop hide an ambiguous possible submission", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const original = provider({
      reviewed,
      async submit() {
        throw new Error("lost response");
      },
    });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
    });
    await firstRun.wait();

    const recovered = provider({ reviewed });
    const resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: firstRun.runId,
      provider: recovered.provider,
    });
    resumed.requestStop();
    const result = await resumed.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "submission-ambiguous",
      steps: [],
    });
    expect(recovered.observe).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
  });

  it("retains finalized predecessors when stopped before pending recovery work", async () => {
    const reviewed = twoStepPlan();
    const store = new MemoryDeploymentRunStore();
    let firstRun: DeploymentRun | undefined;
    const original = provider({
      reviewed,
      async submit(action) {
        return action.step.id === reviewed.steps[0]?.id ? hash("8") : hash("9");
      },
      async observe() {
        firstRun?.requestStop();
        return finalized(reviewed, 0, "8", "10");
      },
    });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
    });
    await firstRun.wait();

    const recovered = provider({ reviewed });
    const resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: firstRun.runId,
      provider: recovered.provider,
    });
    resumed.requestStop();
    const result = await resumed.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "stop-requested",
      steps: [{ stepId: "first:deploy", reference: { reference: hash("8") } }],
    });
    expect(recovered.review).not.toHaveBeenCalled();
    expect(recovered.prepare).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
  });

  it("remains single-flight when resumed observation reenters wait synchronously", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const original = provider({
      reviewed,
      async observe() {
        return { status: "pending" };
      },
    });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await firstRun.wait();

    let resumed: DeploymentRun | undefined;
    let reentrantWait: Promise<unknown> | undefined;
    const recovered = provider({
      reviewed,
      async observe() {
        if (resumed) reentrantWait = resumed.wait();
        return finalized(reviewed);
      },
    });
    resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: firstRun.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });

    const result = await resumed.wait();
    expect(await reentrantWait).toBe(result);
    expect(recovered.observe).toHaveBeenCalledTimes(1);
    expect(recovered.review).not.toHaveBeenCalled();
    expect(recovered.prepare).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
  });

  it("keeps a lost submit response ambiguous and gives resume no submission capability", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const original = provider({
      reviewed,
      async submit() {
        throw new Error("transport lost after possible broadcast");
      },
    });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    const firstResult = await firstRun.wait();
    expect(firstResult.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "submission-ambiguous",
    });
    expect(original.submit).toHaveBeenCalledTimes(1);

    const sameReviewReplay = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
    });
    await expect(sameReviewReplay.wait()).rejects.toMatchObject({ code: "run_store_conflict" });
    expect(original.submit).toHaveBeenCalledTimes(1);

    const replayed = provider({ reviewed });
    const replayClient = createMoesi({ observer: observer(), runStore: store });
    const replayReview = await replayClient.reviewExecution({
      plan: reviewed,
      provider: replayed.provider,
    });
    const replayRun = replayClient.apply({
      plan: reviewed,
      provider: replayed.provider,
      executionReview: replayReview,
    });
    await expect(replayRun.wait()).rejects.toMatchObject({ code: "run_store_conflict" });
    expect(replayed.submit).not.toHaveBeenCalled();

    const recovered = provider({ reviewed });
    const resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: firstRun.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    const result = await resumed.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "submission-ambiguous",
      steps: [],
    });
    expect(resumed.state).toBe("recovery-required");
    expect(recovered.review).not.toHaveBeenCalled();
    expect(recovered.prepare).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
    expect(recovered.observe).not.toHaveBeenCalled();
  });

  it("rejects a different provider before invoking any provider method", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const original = provider({
      reviewed,
      async observe() {
        return { status: "pending" };
      },
    });
    const client = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const run = client.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await run.wait();

    const replacement = provider({ reviewed, id: "other" });
    await expect(
      createMoesi({ observer: observer(), runStore: store }).resume({
        runId: run.runId,
        provider: replacement.provider,
      }),
    ).rejects.toMatchObject({ code: "run_provider_mismatch" });
    expect(replacement.review).not.toHaveBeenCalled();
    expect(replacement.prepare).not.toHaveBeenCalled();
    expect(replacement.submit).not.toHaveBeenCalled();
    expect(replacement.observe).not.toHaveBeenCalled();
  });

  it("rejects a store update that rewrites a retained provider reference", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const selected = provider({
      reviewed,
      async observe() {
        return { status: "pending" };
      },
    });
    const client = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({
      plan: reviewed,
      provider: selected.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await run.wait();
    const record = parseDeploymentRunRecord(await store.get(run.runId));
    const rewritten = {
      ...record,
      revision: record.revision + 1,
      steps: record.steps.map((step) =>
        step.phase === "submitted"
          ? {
              ...step,
              phase: "finalized",
              reference: { ...step.reference, reference: hash("9") },
              providerEvidence: finalized(reviewed).finalized,
            }
          : step,
      ),
    };

    await expect(
      store.save(rewritten as never, { expectedRevision: record.revision }),
    ).rejects.toMatchObject({ code: "run_store_conflict" });
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps[0]).toMatchObject({
      phase: "submitted",
      reference: { reference: hash("8") },
    });
  });

  it("rejects finalized evidence at or before the reviewed planning snapshot", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const selected = provider({
      reviewed,
      async observe() {
        return { status: "pending" };
      },
    });
    const client = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({
      plan: reviewed,
      provider: selected.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await run.wait();
    const record = parseDeploymentRunRecord(await store.get(run.runId));
    const predating = {
      ...record,
      revision: record.revision + 1,
      steps: record.steps.map((step) =>
        step.phase === "submitted"
          ? {
              ...step,
              phase: "finalized",
              providerEvidence: {
                ...finalized(reviewed).finalized,
                blockNumber: reviewed.snapshots[0]!.blockNumber,
              },
            }
          : step,
      ),
    };

    await expect(
      store.save(predating as never, { expectedRevision: record.revision }),
    ).rejects.toMatchObject({ code: "run_record_invalid" });
  });

  it("rejects a later same-chain step advancing before its predecessor finalizes", async () => {
    const reviewed = twoStepPlan();
    const store = new MemoryDeploymentRunStore();
    const selected = provider({
      reviewed,
      async observe() {
        return { status: "pending" };
      },
    });
    const client = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({
      plan: reviewed,
      provider: selected.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await run.wait();
    const record = parseDeploymentRunRecord(await store.get(run.runId));
    const impossible = {
      ...record,
      revision: record.revision + 1,
      steps: record.steps.map((step, index) =>
        index === 1
          ? {
              ...step,
              phase: "submitted",
              reference: { providerId: "fake", chainId: 1, reference: hash("9") },
            }
          : step,
      ),
    };

    await expect(
      store.save(impossible as never, { expectedRevision: record.revision }),
    ).rejects.toMatchObject({ code: "run_record_invalid" });
  });

  it("does not submit when persisting the pre-submit fence fails", async () => {
    const reviewed = plan();
    const memory = new MemoryDeploymentRunStore();
    let failNextSave = true;
    const store = {
      get: (runId: string) => memory.get(runId),
      create: (record: Parameters<typeof memory.create>[0]) => memory.create(record),
      save(record: Parameters<typeof memory.save>[0], options: Parameters<typeof memory.save>[1]) {
        if (failNextSave) {
          failNextSave = false;
          return Promise.reject(new Error("store unavailable"));
        }
        return memory.save(record, options);
      },
    };
    const selected = provider({ reviewed });
    const client = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });

    await expect(run.wait()).rejects.toMatchObject({ code: "run_store_failed" });
    expect(selected.submit).not.toHaveBeenCalled();
    expect(selected.observe).not.toHaveBeenCalled();
    expect(run.state).toBe("recovery-required");
    expect(parseDeploymentRunRecord(await memory.get(run.runId)).steps[0]?.phase).toBe("pending");

    const recovered = provider({ reviewed });
    const resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: run.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await expect(resumed.wait()).resolves.toMatchObject({ status: "converged" });
    expect(recovered.review).toHaveBeenCalledTimes(1);
    expect(recovered.prepare).toHaveBeenCalledTimes(1);
    expect(recovered.submit).toHaveBeenCalledTimes(1);
    expect(recovered.observe).toHaveBeenCalledTimes(1);
  });

  it("resumes only an untouched step after earlier same-chain progress", async () => {
    const reviewed = twoStepPlan();
    const memory = new MemoryDeploymentRunStore();
    let saves = 0;
    const store = {
      get: (runId: string) => memory.get(runId),
      create: (record: Parameters<typeof memory.create>[0]) => memory.create(record),
      save(record: Parameters<typeof memory.save>[0], options: Parameters<typeof memory.save>[1]) {
        saves += 1;
        if (saves === 4) return Promise.reject(new Error("second fence commit failed"));
        return memory.save(record, options);
      },
    };
    const original = provider({
      reviewed,
      async submit(action) {
        return action.step.id === reviewed.steps[0]!.id ? hash("8") : hash("9");
      },
      async observe(reference) {
        return reference.reference === hash("8")
          ? finalized(reviewed, 0, "8", "10")
          : finalized(reviewed, 1, "9", "11");
      },
    });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });

    await expect(firstRun.wait()).rejects.toMatchObject({ code: "run_store_failed" });
    expect(original.submit).toHaveBeenCalledTimes(1);
    expect(parseDeploymentRunRecord(await memory.get(firstRun.runId)).steps).toMatchObject([
      { stepId: reviewed.steps[0]!.id, phase: "finalized" },
      { stepId: reviewed.steps[1]!.id, phase: "pending" },
    ]);

    const recovered = provider({
      reviewed,
      async submit(action) {
        expect(action.step.id).toBe(reviewed.steps[1]!.id);
        return hash("9");
      },
      async observe() {
        return finalized(reviewed, 1, "9", "11");
      },
    });
    const resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: firstRun.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await expect(resumed.wait()).resolves.toMatchObject({ status: "converged" });
    expect(recovered.review).toHaveBeenCalledTimes(1);
    expect(recovered.prepare).toHaveBeenCalledTimes(1);
    expect(recovered.submit).toHaveBeenCalledTimes(1);
    expect(recovered.observe).toHaveBeenCalledTimes(1);
    expect(parseDeploymentRunRecord(await memory.get(firstRun.runId)).steps).toMatchObject([
      { stepId: reviewed.steps[0]!.id, phase: "finalized" },
      { stepId: reviewed.steps[1]!.id, phase: "finalized" },
    ]);
  });

  it("blocks pending continuation when retained finalized evidence was reorged", async () => {
    const reviewed = twoStepPlan();
    const memory = new MemoryDeploymentRunStore();
    let saves = 0;
    const store = {
      get: (runId: string) => memory.get(runId),
      create: (record: Parameters<typeof memory.create>[0]) => memory.create(record),
      save(record: Parameters<typeof memory.save>[0], options: Parameters<typeof memory.save>[1]) {
        saves += 1;
        if (saves === 4) return Promise.reject(new Error("second fence commit failed"));
        return memory.save(record, options);
      },
    };
    const original = provider({
      reviewed,
      async submit() {
        return hash("8");
      },
      async observe() {
        return finalized(reviewed, 0, "8", "10");
      },
    });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await expect(firstRun.wait()).rejects.toMatchObject({ code: "run_store_failed" });

    const canonicalObserver = observer();
    const reorgedObserver: MoesiObservationAdapter = {
      ...canonicalObserver,
      async checkBlockAncestry({ ancestor }) {
        return ancestor.blockNumber !== "10";
      },
    };
    const recovered = provider({ reviewed });
    const resumed = await createMoesi({ observer: reorgedObserver, runStore: store }).resume({
      runId: firstRun.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });

    await expect(resumed.wait()).rejects.toMatchObject({
      code: "execution_ancestry_unverifiable",
    });
    expect(recovered.prepare).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
    expect(recovered.observe).not.toHaveBeenCalled();
    expect(parseDeploymentRunRecord(await memory.get(firstRun.runId)).steps).toMatchObject([
      { phase: "finalized" },
      { phase: "pending" },
    ]);
  });

  it("checks evidence finalized during resume before submitting its pending successor", async () => {
    const reviewed = twoStepPlan();
    const store = new MemoryDeploymentRunStore();
    const original = provider({
      reviewed,
      async observe() {
        return { status: "pending" };
      },
    });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await firstRun.wait();
    expect(parseDeploymentRunRecord(await store.get(firstRun.runId)).steps).toMatchObject([
      { phase: "submitted" },
      { phase: "pending" },
    ]);

    const canonicalObserver = observer();
    const reorgedObserver: MoesiObservationAdapter = {
      ...canonicalObserver,
      async checkBlockAncestry({ ancestor }) {
        return ancestor.blockNumber !== "10";
      },
    };
    const recovered = provider({
      reviewed,
      async observe() {
        return finalized(reviewed, 0, "8", "10");
      },
    });
    const resumed = await createMoesi({ observer: reorgedObserver, runStore: store }).resume({
      runId: firstRun.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });

    await expect(resumed.wait()).rejects.toMatchObject({
      code: "execution_ancestry_unverifiable",
    });
    expect(recovered.observe).toHaveBeenCalledTimes(1);
    expect(recovered.prepare).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
    expect(parseDeploymentRunRecord(await store.get(firstRun.runId)).steps).toMatchObject([
      { phase: "finalized" },
      { phase: "pending" },
    ]);
  });

  it("allows only one concurrent recovery worker to fence and submit pending work", async () => {
    const reviewed = plan();
    const memory = new MemoryDeploymentRunStore();
    let failNextSave = true;
    const store = {
      get: (runId: string) => memory.get(runId),
      create: (record: Parameters<typeof memory.create>[0]) => memory.create(record),
      save(record: Parameters<typeof memory.save>[0], options: Parameters<typeof memory.save>[1]) {
        if (failNextSave) {
          failNextSave = false;
          return Promise.reject(new Error("first fence commit failed"));
        }
        return memory.save(record, options);
      },
    };
    const original = provider({ reviewed });
    const firstClient = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await firstClient.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const firstRun = firstClient.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await expect(firstRun.wait()).rejects.toMatchObject({ code: "run_store_failed" });

    let submissions = 0;
    const recoveredA = provider({
      reviewed,
      async submit() {
        submissions += 1;
        return hash("8");
      },
    });
    const recoveredB = provider({
      reviewed,
      async submit() {
        submissions += 1;
        return hash("8");
      },
    });
    const recoveryClient = createMoesi({ observer: observer(), runStore: store });
    const resumedA = await recoveryClient.resume({
      runId: firstRun.runId,
      provider: recoveredA.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    const resumedB = await recoveryClient.resume({
      runId: firstRun.runId,
      provider: recoveredB.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });

    const outcomes = await Promise.allSettled([resumedA.wait(), resumedB.wait()]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toMatchObject([
      { reason: { code: "run_store_conflict" } },
    ]);
    expect(submissions).toBe(1);
    expect(parseDeploymentRunRecord(await memory.get(firstRun.runId)).steps[0]).toMatchObject({
      phase: "finalized",
    });
  });

  it("leaves an observe-only ambiguous fence when reference persistence fails", async () => {
    const reviewed = plan();
    const memory = new MemoryDeploymentRunStore();
    let saves = 0;
    const store = {
      get: (runId: string) => memory.get(runId),
      create: (record: Parameters<typeof memory.create>[0]) => memory.create(record),
      save(record: Parameters<typeof memory.save>[0], options: Parameters<typeof memory.save>[1]) {
        saves += 1;
        if (saves === 2) return Promise.reject(new Error("reference commit failed"));
        return memory.save(record, options);
      },
    };
    const selected = provider({ reviewed });
    const client = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });

    await expect(run.wait()).rejects.toMatchObject({ code: "run_store_failed" });
    expect(selected.submit).toHaveBeenCalledTimes(1);
    expect(selected.observe).not.toHaveBeenCalled();
    expect(run.state).toBe("recovery-required");
    expect(parseDeploymentRunRecord(await memory.get(run.runId)).steps[0]?.phase).toBe(
      "submission-requested",
    );

    const recovered = provider({ reviewed });
    const resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: run.runId,
      provider: recovered.provider,
    });
    const result = await resumed.wait();
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "submission-ambiguous",
    });
    expect(recovered.submit).not.toHaveBeenCalled();
    expect(recovered.observe).not.toHaveBeenCalled();
  });

  it("rejects a store that returns a different run identity", async () => {
    const reviewed = plan();
    const memory = new MemoryDeploymentRunStore();
    const original = provider({
      reviewed,
      async observe() {
        return { status: "pending" };
      },
    });
    const client = createMoesi({ observer: observer(), runStore: memory });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const run = client.apply({
      plan: reviewed,
      provider: original.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await run.wait();
    const lyingStore = {
      get: () => memory.get(run.runId),
      create: (record: Parameters<typeof memory.create>[0]) => memory.create(record),
      save: (
        record: Parameters<typeof memory.save>[0],
        options: Parameters<typeof memory.save>[1],
      ) => memory.save(record, options),
    };
    const recovered = provider({ reviewed });

    await expect(
      createMoesi({ observer: observer(), runStore: lyingStore }).resume({
        runId: hash("f"),
        provider: recovered.provider,
      }),
    ).rejects.toMatchObject({ code: "run_record_invalid" });
    expect(recovered.observe).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
  });

  it("snapshots the configured run store once", async () => {
    const reviewed = plan();
    const memory = new MemoryDeploymentRunStore();
    let storeReads = 0;
    const selected = provider({ reviewed });
    const client = createMoesi({
      observer: observer(),
      get runStore() {
        storeReads += 1;
        return memory;
      },
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({
      plan: reviewed,
      provider: selected.provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    await run.wait();
    await client.resume({ runId: run.runId, provider: selected.provider });

    expect(storeReads).toBe(1);
  });

  it.each([
    ["run_store_conflict", "deployment run store conflict"],
    ["unsupported_run_version", "deployment run store contains invalid state"],
  ] as const)("preserves %s and scrubs caller-owned store errors", async (code, message) => {
    const reviewed = plan();
    const selected = provider({ reviewed });
    const store = {
      async get() {
        throw new MoesiRunError(code, "raw store secret");
      },
      async create() {
        throw new Error("unused");
      },
      async save() {
        throw new Error("unused");
      },
    };

    await expect(
      createMoesi({ observer: observer(), runStore: store }).resume({
        runId: reviewed.planId,
        provider: selected.provider,
      }),
    ).rejects.toMatchObject({
      code,
      message,
    });
    expect(selected.observe).not.toHaveBeenCalled();
  });

  it("scrubs a forged store error whose machine-code accessor throws", async () => {
    const reviewed = plan();
    const selected = provider({ reviewed });
    const hostileError = Object.create(MoesiRunError.prototype) as object;
    Object.defineProperty(hostileError, "code", {
      get() {
        throw new Error("raw store secret");
      },
    });
    const store = {
      async get() {
        throw hostileError;
      },
      async create() {
        throw new Error("unused");
      },
      async save() {
        throw new Error("unused");
      },
    };

    await expect(
      createMoesi({ observer: observer(), runStore: store }).resume({
        runId: reviewed.planId,
        provider: selected.provider,
      }),
    ).rejects.toMatchObject({
      code: "run_store_failed",
      message: "deployment run store operation failed",
    });
  });
});
