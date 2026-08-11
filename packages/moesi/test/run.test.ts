import { readFile } from "node:fs/promises";
import { type Hex, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type {
  ManagedContractResource,
  MoesiExecutionProvider,
  MoesiManifest,
  MoesiObservationAdapter,
  ReviewedPlan,
  ReviewedPlanAction,
} from "../src/index.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATEX_FACTORY_V1_ADDRESS,
  CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
  createMoesi,
  MemoryDeploymentRunStore,
  parseDeploymentRunRecord,
  reviewPlan,
} from "../src/index.js";
import { verifyChainConvergence } from "../src/verification/convergence.js";
import { missingPlanDraft, testManifest } from "./fixtures.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const CODE = "0x6000" as const;
const FACTORY_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as const;
const SENDER = address("a");
const CREATEX_ENTROPY = `0x${"12".repeat(11)}` as const;

async function createXFactoryRuntime(): Promise<Hex> {
  const runtime = (
    await readFile(new URL("./fixtures/CreateX.runtime.hex", import.meta.url), "utf8")
  ).trim();
  if (!/^0x[0-9a-f]+$/.test(runtime)) throw new Error("invalid CreateX runtime fixture");
  return runtime as Hex;
}

function createXResource(id = "createx"): ManagedContractResource {
  return {
    kind: "managed",
    id,
    deployment: {
      kind: "createx-create2-v1",
      entropy: CREATEX_ENTROPY,
      initCode: "0x60006000",
      value: "0",
      requiresRuntime: [],
    },
    expectedRuntimeCodeHash: keccak256(CODE),
    configuration: [],
    checks: [],
    storageChecks: [],
    sender: { kind: "owner-eoa", address: SENDER },
  };
}

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
      manifest: { version: "moesi.manifest/v2", contracts: [first, second] },
    }),
  );
}

function prerequisitePlan(prerequisiteIds: readonly string[] = ["a-prerequisite"]): ReviewedPlan {
  const dependent = testManifest({
    id: "dependent",
    salt: hash("f"),
    runtimeHash: keccak256(CODE),
    requiresRuntime: prerequisiteIds,
  }).contracts[0]!;
  const prerequisites = prerequisiteIds.map((id, index) => ({
    kind: "external" as const,
    id,
    address: address(index === 0 ? "c" : "d"),
    expectedRuntimeCodeHash: keccak256(CODE),
    checks: [],
    storageChecks: [],
  }));
  const draft = missingPlanDraft({
    manifest: {
      version: "moesi.manifest/v2",
      contracts: [...prerequisites, dependent],
    },
  });
  return reviewPlan({
    ...draft,
    cells: draft.cells.map((cell) =>
      prerequisiteIds.includes(cell.resourceId)
        ? {
            ...cell,
            status: {
              kind: "converged" as const,
              observedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
              configurationResults: [],
              callResults: [],
              storageResults: [],
            },
          }
        : cell,
    ),
  });
}

function configuredMissingPlan(): ReviewedPlan {
  return reviewPlan(
    missingPlanDraft({
      manifest: testManifest({
        runtimeHash: keccak256(CODE),
        configuration: [
          {
            id: "value",
            readData: "0x11111111",
            expectedResult: "0x",
            writeData: "0x22222222",
            value: "0",
          },
        ],
      }),
    }),
  );
}

function twoResourceConfiguredMissingPlan(): ReviewedPlan {
  const first = testManifest({ id: "first", salt: hash("a"), runtimeHash: keccak256(CODE) })
    .contracts[0]!;
  const second = testManifest({
    id: "second",
    salt: hash("b"),
    runtimeHash: keccak256(CODE),
    configuration: [
      {
        id: "value",
        readData: "0x11111111",
        expectedResult: "0x",
        writeData: "0x22222222",
        value: "0",
      },
    ],
  }).contracts[0]!;
  return reviewPlan(
    missingPlanDraft({
      manifest: { version: "moesi.manifest/v2", contracts: [first, second] },
    }),
  );
}

function configuredDriftPlan(): ReviewedPlan {
  const draft = missingPlanDraft({
    manifest: testManifest({
      runtimeHash: keccak256(CODE),
      configuration: [
        {
          id: "value",
          readData: "0x11111111",
          expectedResult: "0x",
          writeData: "0x22222222",
          value: "0",
        },
      ],
    }),
  });
  const cell = draft.cells[0];
  const configuration = draft.steps.find(({ kind }) => kind === "configure");
  if (!cell || !configuration) throw new Error("missing configured drift fixture");
  return reviewPlan({
    ...draft,
    capabilities: [],
    cells: [
      {
        ...cell,
        status: {
          kind: "drift",
          observedRuntimeCodeHash: cell.expectedRuntimeCodeHash,
          configurationMismatches: [{ id: "value", expectedResult: "0x", observedResult: "0x01" }],
          callMismatches: [],
          storageMismatches: [],
        },
      },
    ],
    steps: [{ ...configuration, drift: "configuration-drift" }],
  });
}

function observer(): MoesiObservationAdapter {
  return {
    async captureSnapshot(chainId) {
      return {
        blockNumber: (100n + BigInt(chainId)).toString(10),
        blockHash: hash(chainId === 1 ? "3" : "4"),
      };
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

function sequentialFinalized(action: ReviewedPlanAction) {
  const configuration = action.step.kind === "configure";
  return {
    status: "finalized" as const,
    finalized: {
      ...finalized(action).finalized,
      providerEvidenceId: hash(configuration ? "9" : "8"),
      blockNumber: configuration ? "12" : "11",
      blockHash: hash(configuration ? "7" : "6"),
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
  it("submits only managed work when an external check remains drifted", async () => {
    const managed = testManifest({ runtimeHash: keccak256(CODE) }).contracts[0];
    if (managed === undefined) throw new Error("missing managed run fixture");
    const externalAddress = address("d");
    const manifest = {
      version: "moesi.manifest/v2" as const,
      contracts: [
        managed,
        {
          kind: "external" as const,
          id: "registry",
          address: externalAddress,
          expectedRuntimeCodeHash: keccak256(CODE),
          checks: [
            {
              id: "value",
              caller: address("1"),
              readData: "0x11111111" as const,
              expectedResult: "0x01" as const,
            },
          ],
          storageChecks: [],
        },
      ],
    };
    const reviewed = await createMoesi({
      observer: {
        ...observer(),
        async readCode({ address: target }) {
          if (target === CREATE2_FACTORY_V1_ADDRESS) return FACTORY_CODE;
          return target === externalAddress ? CODE : "0x";
        },
        async readCall() {
          return "0xff";
        },
      },
    }).plan({ manifest, chains: [1] });
    expect(reviewed.disposition).toBe("partial");
    expect(reviewed.steps.map(({ resourceId }) => resourceId)).toEqual(["counter"]);

    const selected = runProvider({
      async observe(action) {
        return {
          status: "finalized",
          finalized: {
            ...finalized(action).finalized,
            blockNumber: "102",
            blockHash: hash("6"),
          },
        };
      },
    });
    const store = new MemoryDeploymentRunStore();
    const client = createMoesi({
      observer: {
        ...observer(),
        async captureSnapshot() {
          return { blockNumber: "103", blockHash: hash("3") };
        },
        async readCode({ address: target }) {
          return target === CREATE2_FACTORY_V1_ADDRESS ? FACTORY_CODE : CODE;
        },
        async readCall() {
          return "0xff";
        },
      },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await client
      .apply({ plan: reviewed, provider: selected.provider, executionReview })
      .wait();

    expect(selected.submit).toHaveBeenCalledOnce();
    expect(selected.submit.mock.calls[0]?.[0].action.step).toMatchObject({
      resourceId: "counter",
      kind: "deploy",
    });
    expect(result.status).toBe("failed");
    expect(result.chains[0]?.status).toBe("drifted");
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "finalized",
      steps: [{ stepId: "counter:deploy" }],
    });
    expect(
      result.chains[0]?.cells.find(({ resourceId }) => resourceId === "registry"),
    ).toMatchObject({
      callChecks: [
        {
          id: "value",
          status: { kind: "drifted", observedResult: "0xff" },
        },
      ],
      status: { kind: "drifted" },
    });
  });

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
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
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

  it("reattests the matching canonical factory for each deployment strategy", async () => {
    const createXRuntime = await createXFactoryRuntime();
    expect(keccak256(createXRuntime)).toBe(CREATEX_FACTORY_V1_RUNTIME_CODE_HASH);
    const arachnid = testManifest({ id: "arachnid", runtimeHash: keccak256(CODE) }).contracts[0];
    if (arachnid === undefined) throw new Error("missing Arachnid resource fixture");
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [
        { ...arachnid, sender: { kind: "owner-eoa", address: SENDER } },
        createXResource(),
      ],
    };
    const reviewed = await createMoesi({
      observer: {
        ...observer(),
        async readCode({ address: target }) {
          if (target === CREATE2_FACTORY_V1_ADDRESS) return FACTORY_CODE;
          if (target === CREATEX_FACTORY_V1_ADDRESS) return createXRuntime;
          return "0x";
        },
      },
    }).plan({ manifest, chains: [1] });
    expect(reviewed.capabilities.map(({ kind }) => kind)).toEqual([
      "create2-factory-v1",
      "createx-factory-v1",
    ]);
    expect(reviewed.steps.map(({ resourceId }) => resourceId)).toEqual(["arachnid", "createx"]);

    const factoryReads: string[] = [];
    const selected = runProvider({
      async submit(action) {
        return hash(action.step.resourceId === "arachnid" ? "8" : "9");
      },
      async observe(action) {
        const createX = action.step.resourceId === "createx";
        return {
          status: "finalized",
          finalized: {
            ...finalized(action).finalized,
            providerEvidenceId: hash(createX ? "9" : "8"),
            blockNumber: createX ? "103" : "102",
            blockHash: hash(createX ? "7" : "6"),
          },
        };
      },
    });
    const client = createMoesi({
      observer: {
        ...observer(),
        async captureSnapshot() {
          return { blockNumber: "200", blockHash: hash("3") };
        },
        async readCode({ address: target }) {
          if (target === CREATE2_FACTORY_V1_ADDRESS) {
            factoryReads.push(target);
            return FACTORY_CODE;
          }
          if (target === CREATEX_FACTORY_V1_ADDRESS) {
            factoryReads.push(target);
            return createXRuntime;
          }
          return CODE;
        },
      },
      runStore: new MemoryDeploymentRunStore(),
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await client
      .apply({ plan: reviewed, provider: selected.provider, executionReview })
      .wait();

    expect(result.status).toBe("converged");
    expect(selected.submit).toHaveBeenCalledTimes(2);
    expect(factoryReads).toEqual([CREATE2_FACTORY_V1_ADDRESS, CREATEX_FACTORY_V1_ADDRESS]);
  });

  it("keeps a CreateX deployment pending when its matching factory is unreadable", async () => {
    const createXRuntime = await createXFactoryRuntime();
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [createXResource()],
    };
    const reviewed = await createMoesi({
      observer: {
        ...observer(),
        async readCode({ address: target }) {
          return target === CREATEX_FACTORY_V1_ADDRESS ? createXRuntime : "0x";
        },
      },
    }).plan({ manifest, chains: [1] });
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider();
    const readCode = vi.fn(async () => {
      throw new Error("untrusted CreateX RPC detail");
    });
    const client = createMoesi({ observer: { ...observer(), readCode }, runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });
    const result = await run.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-capability-unverified",
      steps: [],
    });
    expect(selected.submit).not.toHaveBeenCalled();
    expect(readCode).toHaveBeenCalledWith(
      expect.objectContaining({ address: CREATEX_FACTORY_V1_ADDRESS }),
    );
    expect(JSON.stringify(result)).not.toContain("untrusted CreateX RPC detail");
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps[0]).toMatchObject({
      phase: "pending",
    });
  });

  it("reattests a repaired CreateX factory before submitting a pending resume", async () => {
    const createXRuntime = await createXFactoryRuntime();
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v2",
      contracts: [createXResource("createx-repair")],
    };
    const reviewed = await createMoesi({
      observer: {
        ...observer(),
        async readCode({ address: target }) {
          return target === CREATEX_FACTORY_V1_ADDRESS ? createXRuntime : "0x";
        },
      },
    }).plan({ manifest, chains: [1] });
    const store = new MemoryDeploymentRunStore();
    let repaired = false;
    const factoryReads: boolean[] = [];
    const runtimeObserver: MoesiObservationAdapter = {
      ...observer(),
      async captureSnapshot() {
        return { blockNumber: "200", blockHash: hash("3") };
      },
      async readCode({ address: target }) {
        if (target === CREATEX_FACTORY_V1_ADDRESS) {
          factoryReads.push(repaired);
          return repaired ? createXRuntime : ("0x6001" as const);
        }
        return CODE;
      },
    };
    const original = runProvider();
    const client = createMoesi({ observer: runtimeObserver, runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: original.provider,
    });
    const run = client.apply({ plan: reviewed, provider: original.provider, executionReview });
    const failed = await run.wait();

    expect(failed.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-capability-mismatch",
      steps: [],
    });
    expect(original.submit).not.toHaveBeenCalled();
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps[0]).toMatchObject({
      phase: "pending",
    });

    repaired = true;
    const recovered = runProvider({
      async observe(action) {
        return {
          status: "finalized",
          finalized: { ...finalized(action).finalized, blockNumber: "102" },
        };
      },
    });
    const resumed = await createMoesi({ observer: runtimeObserver, runStore: store }).resume({
      runId: run.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    const result = await resumed.wait();

    expect(result.status).toBe("converged");
    expect(recovered.submit).toHaveBeenCalledOnce();
    expect(factoryReads).toEqual([false, true]);
  });

  it("keeps a deployment pending when the canonical factory runtime changed", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider();
    const readCode = vi.fn(
      async (_request: Parameters<MoesiObservationAdapter["readCode"]>[0]) => "0x6001" as const,
    );
    const client = createMoesi({ observer: { ...observer(), readCode }, runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });

    const result = await run.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-capability-mismatch",
      steps: [],
    });
    expect(selected.submit).not.toHaveBeenCalled();
    expect(readCode).toHaveBeenCalledOnce();
    expect(readCode.mock.calls[0]?.[0]).toMatchObject({
      chainId: 1,
      address: CREATE2_FACTORY_V1_ADDRESS,
      snapshot: { chainId: 1, blockNumber: "101", blockHash: hash("3") },
    });
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps[0]).toMatchObject({
      phase: "pending",
    });
  });

  it("keeps a deployment pending when the canonical factory runtime is unreadable", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider();
    const readCode = vi.fn(async () => {
      throw new Error("raw RPC detail");
    });
    const client = createMoesi({ observer: { ...observer(), readCode }, runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });

    const result = await run.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-capability-unverified",
      steps: [],
    });
    expect(JSON.stringify(result)).not.toContain("raw RPC detail");
    expect(selected.submit).not.toHaveBeenCalled();
    expect(readCode).toHaveBeenCalledOnce();
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps[0]).toMatchObject({
      phase: "pending",
    });
  });

  it("keeps a deployment pending when its fresh factory snapshot lineage is uncertain", async () => {
    const reviewed = plan();
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider();
    let ancestryChecks = 0;
    const readCode = vi.fn(async () => FACTORY_CODE);
    const client = createMoesi({
      observer: {
        ...observer(),
        readCode,
        async checkBlockAncestry() {
          ancestryChecks += 1;
          return ancestryChecks === 1;
        },
      },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });

    const result = await run.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-capability-unverified",
      steps: [],
    });
    expect(ancestryChecks).toBe(2);
    expect(readCode).not.toHaveBeenCalled();
    expect(selected.submit).not.toHaveBeenCalled();
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps[0]).toMatchObject({
      phase: "pending",
    });
  });

  it("gates every deployment against planning and finalized same-chain ancestry", async () => {
    const reviewed = twoStepPlan();
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider({
      async submit(action) {
        return hash(action.step.resourceId === "first" ? "8" : "9");
      },
      async observe(action) {
        const second = action.step.resourceId === "second";
        return {
          status: "finalized",
          finalized: {
            ...finalized(action).finalized,
            providerEvidenceId: hash(second ? "9" : "8"),
            blockNumber: second ? "12" : "11",
            blockHash: hash(second ? "7" : "6"),
          },
        };
      },
    });
    let factoryReads = 0;
    const readCode = vi.fn(
      async ({ address: target }: Parameters<MoesiObservationAdapter["readCode"]>[0]) => {
        if (target !== CREATE2_FACTORY_V1_ADDRESS) return CODE;
        factoryReads += 1;
        return factoryReads === 1 ? FACTORY_CODE : ("0x6001" as const);
      },
    );
    const checkBlockAncestry = vi.fn(
      async (_request: Parameters<MoesiObservationAdapter["checkBlockAncestry"]>[0]) => true,
    );
    const client = createMoesi({
      observer: { ...observer(), readCode, checkBlockAncestry },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });

    const result = await run.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-capability-mismatch",
      steps: [{ stepId: "first:deploy" }],
    });
    expect(selected.submit).toHaveBeenCalledTimes(1);
    expect(
      readCode.mock.calls.filter(([request]) => request.address === CREATE2_FACTORY_V1_ADDRESS),
    ).toHaveLength(2);
    expect(
      checkBlockAncestry.mock.calls.some(
        ([request]) =>
          request.ancestor.blockNumber === "11" && request.ancestor.blockHash === hash("6"),
      ),
    ).toBe(true);
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
      { stepId: "first:deploy", phase: "finalized" },
      { stepId: "second:deploy", phase: "pending" },
    ]);
  });

  it("keeps a dependent deployment pending when a runtime prerequisite changed", async () => {
    const reviewed = prerequisitePlan();
    const prerequisite = reviewed.cells.find(({ resourceId }) => resourceId === "a-prerequisite");
    if (prerequisite === undefined) throw new Error("missing prerequisite cell");
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider();
    const readCode = vi.fn(
      async ({ address: target }: Parameters<MoesiObservationAdapter["readCode"]>[0]) =>
        target === CREATE2_FACTORY_V1_ADDRESS
          ? FACTORY_CODE
          : target === prerequisite.address
            ? ("0x6001" as const)
            : CODE,
    );
    const client = createMoesi({
      observer: { ...observer(), readCode },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });

    const result = await run.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-prerequisite-mismatch",
      steps: [],
    });
    expect(selected.submit).not.toHaveBeenCalled();
    expect(readCode.mock.calls.map(([request]) => request.address)).toEqual([
      CREATE2_FACTORY_V1_ADDRESS,
      prerequisite.address,
    ]);
    expect(readCode.mock.calls[0]?.[0].snapshot).toBe(readCode.mock.calls[1]?.[0].snapshot);
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
      { stepId: "dependent:deploy", phase: "pending" },
    ]);
  });

  it("keeps a dependent deployment pending when prerequisite runtime is unreadable", async () => {
    const reviewed = prerequisitePlan();
    const prerequisite = reviewed.cells.find(({ resourceId }) => resourceId === "a-prerequisite");
    if (prerequisite === undefined) throw new Error("missing prerequisite cell");
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider();
    const readCode = vi.fn(
      async ({ address: target }: Parameters<MoesiObservationAdapter["readCode"]>[0]) => {
        if (target === CREATE2_FACTORY_V1_ADDRESS) return FACTORY_CODE;
        if (target === prerequisite.address) throw new Error("credential-bearing RPC failure");
        return CODE;
      },
    );
    const client = createMoesi({
      observer: { ...observer(), readCode },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });

    const result = await run.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-prerequisite-unverified",
      steps: [],
    });
    expect(JSON.stringify(result)).not.toContain("credential-bearing RPC failure");
    expect(selected.submit).not.toHaveBeenCalled();
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
      { stepId: "dependent:deploy", phase: "pending" },
    ]);
  });

  it("stops prerequisite reads at the first mismatch", async () => {
    const reviewed = prerequisitePlan(["a-prerequisite", "b-prerequisite"]);
    const first = reviewed.cells.find(({ resourceId }) => resourceId === "a-prerequisite");
    const second = reviewed.cells.find(({ resourceId }) => resourceId === "b-prerequisite");
    if (first === undefined || second === undefined) throw new Error("missing prerequisite cells");
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider();
    const readCode = vi.fn(
      async ({ address: target }: Parameters<MoesiObservationAdapter["readCode"]>[0]) =>
        target === CREATE2_FACTORY_V1_ADDRESS
          ? FACTORY_CODE
          : target === first.address
            ? ("0x6001" as const)
            : CODE,
    );
    const client = createMoesi({
      observer: { ...observer(), readCode },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const result = await client
      .apply({ plan: reviewed, provider: selected.provider, executionReview })
      .wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-prerequisite-mismatch",
      steps: [],
    });
    expect(readCode.mock.calls.map(([request]) => request.address)).toEqual([
      CREATE2_FACTORY_V1_ADDRESS,
      first.address,
    ]);
    expect(readCode.mock.calls.some(([request]) => request.address === second.address)).toBe(false);
    expect(selected.submit).not.toHaveBeenCalled();
  });

  it("reruns the prerequisite gate for a repaired pending deployment on resume", async () => {
    const reviewed = prerequisitePlan();
    const prerequisite = reviewed.cells.find(({ resourceId }) => resourceId === "a-prerequisite");
    if (prerequisite === undefined) throw new Error("missing prerequisite cell");
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider();
    let repaired = false;
    const prerequisiteReads: boolean[] = [];
    const runtimeObserver: MoesiObservationAdapter = {
      ...observer(),
      async readCode({ address: target }) {
        if (target === CREATE2_FACTORY_V1_ADDRESS) return FACTORY_CODE;
        if (target === prerequisite.address) {
          prerequisiteReads.push(repaired);
          return repaired ? CODE : ("0x6001" as const);
        }
        return CODE;
      },
    };
    const client = createMoesi({ observer: runtimeObserver, runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });
    const failed = await run.wait();

    expect(failed.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-prerequisite-mismatch",
    });
    expect(selected.submit).not.toHaveBeenCalled();
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps[0]).toMatchObject({
      phase: "pending",
    });

    repaired = true;
    const recovered = runProvider();
    const resumed = await createMoesi({ observer: runtimeObserver, runStore: store }).resume({
      runId: run.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    const recoveredResult = await resumed.wait();

    expect(recovered.submit).toHaveBeenCalledOnce();
    expect(recoveredResult.status).toBe("converged");
    expect(prerequisiteReads).toEqual([false, true, true]);
  });

  it("does not rerun a deployment gate for an ambiguous submission fence", async () => {
    const reviewed = prerequisitePlan();
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider({
      async submit() {
        throw new Error("submission outcome unknown");
      },
    });
    const client = createMoesi({ observer: observer(), runStore: store });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });
    await run.wait();
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps[0]).toMatchObject({
      phase: "submission-requested",
    });

    const readCode = vi.fn(async () => {
      throw new Error("gate must not run");
    });
    const recovered = runProvider();
    const resumed = await createMoesi({
      observer: { ...observer(), readCode },
      runStore: store,
    }).resume({ runId: run.runId, provider: recovered.provider });
    const result = await resumed.wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "submission-ambiguous",
    });
    expect(readCode).not.toHaveBeenCalled();
    expect(recovered.prepare).not.toHaveBeenCalled();
    expect(recovered.submit).not.toHaveBeenCalled();
    expect(recovered.observe).not.toHaveBeenCalled();
  });

  it("observes a retained submitted deployment before any runtime reads", async () => {
    const reviewed = prerequisitePlan();
    const store = new MemoryDeploymentRunStore();
    let finalize = false;
    const events: string[] = [];
    const selected = runProvider({
      async observe(action) {
        events.push("observe");
        return finalize ? finalized(action) : { status: "pending" };
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
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps[0]).toMatchObject({
      phase: "submitted",
    });

    finalize = true;
    events.length = 0;
    const resumed = await createMoesi({
      observer: {
        ...observer(),
        async readCode({ address: target }) {
          events.push(`read:${target}`);
          return target === CREATE2_FACTORY_V1_ADDRESS ? FACTORY_CODE : CODE;
        },
      },
      runStore: store,
    }).resume({
      runId: run.runId,
      provider: selected.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    const result = await resumed.wait();

    expect(events[0]).toBe("observe");
    expect(events).not.toContain(`read:${CREATE2_FACTORY_V1_ADDRESS}`);
    expect(selected.prepare).toHaveBeenCalledOnce();
    expect(selected.submit).toHaveBeenCalledOnce();
    expect(result.status).toBe("converged");
  });

  it("checks deployed runtime code before fencing or submitting configuration", async () => {
    const reviewed = configuredMissingPlan();
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider({
      async submit(action) {
        return hash(action.step.kind === "configure" ? "9" : "8");
      },
      async observe(action) {
        return sequentialFinalized(action);
      },
    });
    const client = createMoesi({
      observer: {
        ...observer(),
        async readCode({ address: target }) {
          return target === CREATE2_FACTORY_V1_ADDRESS ? FACTORY_CODE : "0x6001";
        },
      },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });
    const result = await run.wait();

    expect(selected.submit).toHaveBeenCalledTimes(1);
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "configuration-runtime-mismatch",
      steps: [{ stepId: "counter:deploy" }],
    });
    expect(run.state).toBe("recovery-required");
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
      { stepId: "counter:deploy", phase: "finalized" },
      { stepId: "counter:configure:value", phase: "pending" },
    ]);

    const recovered = runProvider({
      async submit(action) {
        return hash(action.step.kind === "configure" ? "9" : "8");
      },
      async observe(action) {
        return sequentialFinalized(action);
      },
    });
    const resumed = await createMoesi({ observer: observer(), runStore: store }).resume({
      runId: run.runId,
      provider: recovered.provider,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    const recoveredResult = await resumed.wait();

    expect(recovered.submit).toHaveBeenCalledTimes(1);
    expect(recovered.submit.mock.calls[0]?.[0].action.step.kind).toBe("configure");
    expect(recoveredResult.status).toBe("converged");
  });

  it("checks every newly deployed runtime before configuring one resource", async () => {
    const reviewed = twoResourceConfiguredMissingPlan();
    const firstCell = reviewed.cells.find(({ resourceId }) => resourceId === "first");
    const secondCell = reviewed.cells.find(({ resourceId }) => resourceId === "second");
    if (!firstCell || !secondCell) throw new Error("missing configured resource cells");
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider({
      async submit(action) {
        return hash(action.step.resourceId === "first" ? "8" : "9");
      },
      async observe(action) {
        const second = action.step.resourceId === "second";
        return {
          status: "finalized",
          finalized: {
            ...finalized(action).finalized,
            providerEvidenceId: hash(second ? "9" : "8"),
            blockNumber: second ? "12" : "11",
            blockHash: hash(second ? "7" : "6"),
          },
        };
      },
    });
    const readCode = vi.fn(
      async ({ address: target }: Parameters<MoesiObservationAdapter["readCode"]>[0]) =>
        target === CREATE2_FACTORY_V1_ADDRESS
          ? FACTORY_CODE
          : target === firstCell.address
            ? ("0x6001" as const)
            : CODE,
    );
    const client = createMoesi({
      observer: { ...observer(), readCode },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });
    const result = await run.wait();

    expect(selected.submit).toHaveBeenCalledTimes(2);
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "configuration-runtime-mismatch",
      steps: [{ stepId: "first:deploy" }, { stepId: "second:deploy" }],
    });
    const configurationReads = readCode.mock.calls.filter(
      ([request]) => request.address !== CREATE2_FACTORY_V1_ADDRESS,
    );
    expect(configurationReads.map(([request]) => request.address)).toEqual([
      firstCell.address,
      secondCell.address,
    ]);
    expect(configurationReads[0]?.[0].snapshot).toBe(configurationReads[1]?.[0].snapshot);
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
      { stepId: "first:deploy", phase: "finalized" },
      { stepId: "second:deploy", phase: "finalized" },
      { stepId: "second:configure:value", phase: "pending" },
    ]);
  });

  it("keeps configuration pending when deployed runtime evidence is unreadable", async () => {
    const reviewed = configuredMissingPlan();
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider({
      async submit(action) {
        return hash(action.step.kind === "configure" ? "9" : "8");
      },
      async observe(action) {
        return sequentialFinalized(action);
      },
    });
    const client = createMoesi({
      observer: {
        ...observer(),
        async readCode({ address: target }) {
          if (target === CREATE2_FACTORY_V1_ADDRESS) return FACTORY_CODE;
          throw new Error("raw RPC detail");
        },
      },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });
    const result = await run.wait();

    expect(selected.submit).toHaveBeenCalledTimes(1);
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "configuration-runtime-unverified",
      steps: [{ stepId: "counter:deploy" }],
    });
    expect(JSON.stringify(result)).not.toContain("raw RPC detail");
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
      { stepId: "counter:deploy", phase: "finalized" },
      { stepId: "counter:configure:value", phase: "pending" },
    ]);
  });

  it("keeps configuration pending when fresh deployment ancestry is not canonical", async () => {
    const reviewed = configuredMissingPlan();
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider({
      async submit(action) {
        return hash(action.step.kind === "configure" ? "9" : "8");
      },
      async observe(action) {
        return sequentialFinalized(action);
      },
    });
    let ancestryChecks = 0;
    const readCode = vi.fn(
      async ({ address: target }: Parameters<MoesiObservationAdapter["readCode"]>[0]) =>
        target === CREATE2_FACTORY_V1_ADDRESS ? FACTORY_CODE : CODE,
    );
    const client = createMoesi({
      observer: {
        ...observer(),
        readCode,
        async checkBlockAncestry({ ancestor }) {
          ancestryChecks += 1;
          return ancestor.blockNumber !== "11";
        },
      },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });
    const result = await run.wait();

    expect(selected.submit).toHaveBeenCalledTimes(1);
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "configuration-runtime-unverified",
      steps: [{ stepId: "counter:deploy" }],
    });
    expect(ancestryChecks).toBe(4);
    expect(readCode.mock.calls.map(([request]) => request.address)).toEqual([
      CREATE2_FACTORY_V1_ADDRESS,
    ]);
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
      { stepId: "counter:deploy", phase: "finalized" },
      { stepId: "counter:configure:value", phase: "pending" },
    ]);
  });

  it("rechecks configuration-drift runtime before its durable submission fence", async () => {
    const reviewed = configuredDriftPlan();
    const store = new MemoryDeploymentRunStore();
    const selected = runProvider();
    const client = createMoesi({
      observer: {
        ...observer(),
        async readCode() {
          return "0x6001";
        },
      },
      runStore: store,
    });
    const executionReview = await client.reviewExecution({
      plan: reviewed,
      provider: selected.provider,
    });
    const run = client.apply({ plan: reviewed, provider: selected.provider, executionReview });
    const result = await run.wait();

    expect(selected.submit).not.toHaveBeenCalled();
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "configuration-runtime-mismatch",
      steps: [],
    });
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
      { stepId: "counter:configure:value", phase: "pending" },
    ]);
  });

  it("lets independent chains converge or fail without borrowing evidence", async () => {
    const selected = runProvider({
      async submit(action) {
        if (action.chainId === 10) throw new Error("chain unavailable");
        return hash("8");
      },
    });
    const reviewed = plan([10, 1]);
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
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
      reason: "submission-ambiguous",
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
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
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
    const moesi = createMoesi({
      observer: staleObserver,
      runStore: new MemoryDeploymentRunStore(),
    });
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
      reason: "snapshot-before-anchor",
    });
  });

  it("rejects one provider operation reused for two reviewed actions", async () => {
    const selected = runProvider();
    const reviewed = twoStepPlan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
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
      reason: "submission-ambiguous",
      steps: [{ stepId: "first:deploy" }],
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
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
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
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
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
    const moesi = createMoesi({
      observer: staleObserver,
      runStore: new MemoryDeploymentRunStore(),
    });
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
    const moesi = createMoesi({
      observer: ancestryObserver,
      runStore: new MemoryDeploymentRunStore(),
    });
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
