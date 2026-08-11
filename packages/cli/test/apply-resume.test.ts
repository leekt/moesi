import {
  createMoesi,
  type DeploymentCall,
  type DeploymentRunStore,
  MemoryDeploymentRunStore,
  type MoesiExecutionProvider,
  type MoesiObservationAdapter,
  parseDeploymentRunRecord,
  type ReviewedPlan,
} from "moesi";
import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { CliIo } from "../src/command.js";
import { runCli } from "../src/command.js";
import type { CliViemRuntimeFactory, CreateCliViemRuntimeInput } from "../src/viem-runtime.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const CODE = "0x6000" as const;
const RUNTIME_HASH = keccak256(CODE);
const SENDER = address("a");
const PRIVATE_KEY = `0x${"99".repeat(32)}`;
const TX_HASH = hash("8");
const REFERENCE = `viem-tx-v1:${TX_HASH}:confirmations-1`;
const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

interface RuntimeState {
  submissions: number;
  observations: number;
  observation: "pending" | "finalized";
  deployed: boolean;
  call: DeploymentCall | null;
  sender: `0x${string}`;
  blockedReason: string | null;
  reviewFailure: string | null;
  onSubmit: (() => void) | null;
}

async function planArtifact(
  chains: readonly number[] = [1],
  resourceCount = 1,
): Promise<{ readonly plan: ReviewedPlan; readonly source: string }> {
  const client = createMoesi({
    observer: {
      async captureSnapshot() {
        return { blockNumber: "100", blockHash: hash("1") };
      },
      async readCode() {
        return "0x";
      },
      async readCall() {
        return "0x";
      },
      async checkBlockAncestry() {
        return true;
      },
    },
  });
  const plan = await client.plan({
    chains,
    manifest: {
      version: "moesi.manifest/v1",
      contracts: Array.from({ length: resourceCount }, (_, index) => ({
        id: index === 0 ? "counter" : `counter-${index + 1}`,
        deployment: {
          kind: "create2-factory-v1",
          factory: CREATE2_FACTORY,
          salt: hash((12 + index).toString(16)),
          initCode: "0x60006000",
          value: "0",
        },
        expectedRuntimeCodeHash: RUNTIME_HASH,
        configuration: [],
      })),
    },
  });
  return { plan, source: JSON.stringify({ version: "moesi.cli-plan/v1", plan }) };
}

function runtimeFactory(state: RuntimeState): CliViemRuntimeFactory {
  return (input: CreateCliViemRuntimeInput) => {
    const observer: MoesiObservationAdapter = {
      async captureSnapshot() {
        return state.deployed
          ? { blockNumber: "102", blockHash: hash("3") }
          : { blockNumber: "100", blockHash: hash("1") };
      },
      async readCode() {
        return state.deployed ? CODE : "0x";
      },
      async readCall() {
        return "0x";
      },
      async checkBlockAncestry() {
        return true;
      },
    };
    const provider: MoesiExecutionProvider = {
      id: "viem",
      async review({ plan }) {
        if (state.reviewFailure !== null) throw new Error(state.reviewFailure);
        return {
          providerId: "viem",
          status: state.blockedReason === null ? "supported" : "blocked",
          chains: plan.requirements.map(({ chainId }) => ({
            chainId,
            sender: state.sender,
            accountId: null,
            route: `viem-direct-eoa:confirmations-${input.confirmations}`,
            enforcement: {
              calls: "interactive-owner" as const,
              expiry: "not-enforced" as const,
              operationCount: "not-enforced" as const,
            },
          })),
          reasons:
            state.blockedReason === null
              ? []
              : [{ code: state.blockedReason, chainId: 1, stepId: null }],
        };
      },
      async prepare({ plan }) {
        return { providerId: "viem", planId: plan.planId, binding: null };
      },
      async submit({ action }) {
        state.submissions += 1;
        state.call = action.step.call;
        state.deployed = true;
        state.onSubmit?.();
        return {
          providerId: "viem",
          chainId: action.chainId,
          reference: `viem-tx-v1:${TX_HASH}:confirmations-${input.confirmations}`,
        };
      },
      async observe() {
        state.observations += 1;
        if (state.observation === "pending") return { status: "pending" };
        if (state.call === null) throw new Error("missing submitted call");
        return {
          status: "finalized",
          finalized: {
            chainId: 1,
            sender: state.sender,
            calls: [state.call],
            providerEvidenceId: TX_HASH,
            blockNumber: "101",
            blockHash: hash("2"),
          },
        };
      },
    };
    return { observer, provider };
  };
}

function state(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    submissions: 0,
    observations: 0,
    observation: "finalized",
    deployed: false,
    call: null,
    sender: SENDER,
    blockedReason: null,
    reviewFailure: null,
    onSubmit: null,
    ...overrides,
  };
}

function harness(input: {
  readonly source: string;
  readonly store: DeploymentRunStore;
  readonly runtime: CliViemRuntimeFactory;
  readonly privateKey?: string;
}): {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly reads: ReturnType<typeof vi.fn>;
  readonly signal: (signal: "SIGINT" | "SIGTERM") => void;
  readonly signalHandlersRemoved: () => boolean;
} {
  const output: string[] = [];
  const errors: string[] = [];
  const reads = vi.fn((name: string) =>
    name === "MOESI_TEST_PRIVATE_KEY" ? (input.privateKey ?? PRIVATE_KEY) : undefined,
  );
  let signalHandler: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
  let signalHandlersRemoved = false;
  return {
    io: {
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      async readFile() {
        return input.source;
      },
      async fetch() {
        throw new Error("injected runtime must own RPC");
      },
      createRunStore: () => input.store,
      readEnv: reads,
      createViemRuntime: input.runtime,
      installSignalHandlers(handler) {
        signalHandler = handler;
        signalHandlersRemoved = false;
        return () => {
          signalHandler = undefined;
          signalHandlersRemoved = true;
        };
      },
    },
    stdout: () => output.join(""),
    stderr: () => errors.join(""),
    reads,
    signal: (signal) => signalHandler?.(signal),
    signalHandlersRemoved: () => signalHandlersRemoved,
  };
}

const applyArguments = (
  acceptedReview?: string,
  confirmations = 1,
  storeDirectory = "./runs",
): string[] => [
  "apply",
  "--plan",
  "./plan.json",
  "--provider",
  "viem",
  "--chain",
  "1=http://127.0.0.1:8545/?token=rpc-secret",
  "--signer",
  "1=MOESI_TEST_PRIVATE_KEY",
  "--confirmations",
  String(confirmations),
  "--store",
  storeDirectory,
  "--observe-attempts",
  "1",
  "--observe-delay-ms",
  "0",
  ...(acceptedReview === undefined ? [] : ["--accept-review", acceptedReview]),
  "--json",
];

const resumeArguments = (includeSigner = false, confirmations = 1): string[] => [
  "resume",
  "--run",
  "RUN_ID",
  "--provider",
  "viem",
  "--chain",
  "1=http://127.0.0.1:8545/?token=rpc-secret",
  ...(includeSigner ? ["--signer", "1=MOESI_TEST_PRIVATE_KEY"] : []),
  "--confirmations",
  String(confirmations),
  "--store",
  "./runs",
  "--observe-attempts",
  "1",
  "--observe-delay-ms",
  "0",
  "--json",
];

describe("moesi apply and resume", () => {
  it("renders an exact provider review and requires its digest before any durable or wallet effect", async () => {
    const artifact = await planArtifact();
    const runtimeState = state();
    const store = new MemoryDeploymentRunStore();
    const test = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });

    expect(await runCli(applyArguments(), test.io)).toBe(2);
    const output = JSON.parse(test.stdout());
    expect(output).toMatchObject({
      version: "moesi.cli-execution-review/v1",
      planId: artifact.plan.planId,
      provider: {
        providerId: "viem",
        status: "supported",
        chains: [
          {
            sender: SENDER,
            route: "viem-direct-eoa:confirmations-1",
            enforcement: {
              calls: "interactive-owner",
              expiry: "not-enforced",
              operationCount: "not-enforced",
            },
          },
        ],
      },
      atomicity: "one-transaction-per-action",
      partialProgress: true,
      disposition: "changes",
      steps: [{ call: artifact.plan.steps[0]?.call }],
    });
    expect(output.reviewId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(output.runStoreId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(runtimeState.submissions).toBe(0);
    expect(await store.get(artifact.plan.planId)).toBeUndefined();
    expect(test.stdout()).not.toContain(PRIVATE_KEY);
    expect(test.stdout()).not.toContain("rpc-secret");
    expect(test.stderr()).toBe("");
  });

  it("executes only the recomputed accepted review and emits a converged run result", async () => {
    const artifact = await planArtifact();
    const runtimeState = state();
    const store = new MemoryDeploymentRunStore();
    const preview = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(), preview.io)).toBe(2);
    const reviewId = JSON.parse(preview.stdout()).reviewId as string;

    const accepted = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(reviewId), accepted.io)).toBe(0);
    const output = JSON.parse(accepted.stdout());
    expect(output).toMatchObject({
      version: "moesi.cli-run-result/v1",
      runState: "complete",
      result: { runId: artifact.plan.planId, status: "converged" },
    });
    expect(runtimeState.submissions).toBe(1);
    expect(parseDeploymentRunRecord(await store.get(artifact.plan.planId)).steps[0]).toMatchObject({
      phase: "finalized",
      reference: { reference: REFERENCE },
    });
    expect(accepted.stderr()).toBe("");
  });

  it("invalidates acceptance when sender or confirmation policy changes", async () => {
    const artifact = await planArtifact();
    const initialState = state();
    const store = new MemoryDeploymentRunStore();
    const preview = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(initialState),
    });
    expect(await runCli(applyArguments(), preview.io)).toBe(2);
    const reviewId = JSON.parse(preview.stdout()).reviewId as string;

    const changedState = state({ sender: address("d") });
    const changed = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(changedState),
    });
    expect(await runCli(applyArguments(reviewId), changed.io)).toBe(1);
    expect(JSON.parse(changed.stderr()).error.code).toBe("execution_review_mismatch");
    expect(changedState.submissions).toBe(0);
    expect(await store.get(artifact.plan.planId)).toBeUndefined();

    const changedConfirmations = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(initialState),
    });
    expect(await runCli(applyArguments(reviewId, 2), changedConfirmations.io)).toBe(1);
    expect(JSON.parse(changedConfirmations.stderr()).error.code).toBe("execution_review_mismatch");
    expect(initialState.submissions).toBe(0);

    const changedStore = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(initialState),
    });
    expect(await runCli(applyArguments(reviewId, 1, "./other-runs"), changedStore.io)).toBe(1);
    expect(JSON.parse(changedStore.stderr()).error.code).toBe("execution_review_mismatch");
    expect(initialState.submissions).toBe(0);
  });

  it("renders blocked enforcement reasons and never accepts or submits them", async () => {
    const artifact = await planArtifact();
    const runtimeState = state({ blockedReason: "onchain-call-scope-required" });
    const store = new MemoryDeploymentRunStore();
    const test = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });

    expect(await runCli(applyArguments(hash("f")), test.io)).toBe(3);
    expect(JSON.parse(test.stdout())).toMatchObject({
      provider: {
        status: "blocked",
        reasons: [{ code: "onchain-call-scope-required" }],
      },
    });
    expect(runtimeState.submissions).toBe(0);
    expect(await store.get(artifact.plan.planId)).toBeUndefined();
  });

  it("reconstructs a submitted viem run and observes it without a signer or second send", async () => {
    const artifact = await planArtifact();
    const runtimeState = state({ observation: "pending" });
    const store = new MemoryDeploymentRunStore();
    const preview = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(), preview.io)).toBe(2);
    const reviewId = JSON.parse(preview.stdout()).reviewId as string;
    const applied = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(reviewId), applied.io)).toBe(3);
    expect(runtimeState.submissions).toBe(1);
    expect(JSON.parse(applied.stdout())).toMatchObject({
      runState: "recovery-required",
      result: { status: "failed" },
    });

    runtimeState.observation = "finalized";
    const resumed = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    const args = resumeArguments().map((argument) =>
      argument === "RUN_ID" ? artifact.plan.planId : argument,
    );
    expect(await runCli(args, resumed.io)).toBe(0);
    expect(JSON.parse(resumed.stdout())).toMatchObject({
      version: "moesi.cli-run-result/v1",
      runState: "complete",
      result: { runId: artifact.plan.planId, status: "converged" },
    });
    expect(runtimeState.submissions).toBe(1);
    expect(resumed.reads).not.toHaveBeenCalled();
  });

  it("rejects a retained viem reference whose finality policy contradicts the durable review", async () => {
    const artifact = await planArtifact();
    const runtimeState = state({ observation: "pending" });
    const memory = new MemoryDeploymentRunStore();
    const preview = harness({
      source: artifact.source,
      store: memory,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(), preview.io)).toBe(2);
    const reviewId = JSON.parse(preview.stdout()).reviewId as string;
    const applied = harness({
      source: artifact.source,
      store: memory,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(reviewId), applied.io)).toBe(3);

    const stored = JSON.parse(JSON.stringify(await memory.get(artifact.plan.planId))) as {
      executionReview: { provider: { chains: Array<{ route: string }> } };
    };
    const storedChainReview = stored.executionReview.provider.chains[0];
    if (storedChainReview === undefined) throw new Error("stored review lacked a chain");
    storedChainReview.route = "viem-direct-eoa:confirmations-64";
    const contradictoryStore: DeploymentRunStore = {
      get: async () => stored as never,
      create: async () => {
        throw new Error("unexpected create");
      },
      save: async () => {
        throw new Error("unexpected save");
      },
    };
    const resumed = harness({
      source: artifact.source,
      store: contradictoryStore,
      runtime: runtimeFactory(runtimeState),
    });
    const args = resumeArguments(false, 64).map((argument) =>
      argument === "RUN_ID" ? artifact.plan.planId : argument,
    );
    expect(await runCli(args, resumed.io)).toBe(1);
    expect(JSON.parse(resumed.stderr()).error.code).toBe("run_provider_mismatch");
    expect(runtimeState.observations).toBe(1);
  });

  it("rejects finalized viem evidence that names a transaction other than its retained reference", async () => {
    const artifact = await planArtifact();
    const runtimeState = state();
    const memory = new MemoryDeploymentRunStore();
    const preview = harness({
      source: artifact.source,
      store: memory,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(), preview.io)).toBe(2);
    const reviewId = JSON.parse(preview.stdout()).reviewId as string;
    const applied = harness({
      source: artifact.source,
      store: memory,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(reviewId), applied.io)).toBe(0);

    const stored = JSON.parse(JSON.stringify(await memory.get(artifact.plan.planId))) as {
      steps: Array<{ providerEvidence?: { providerEvidenceId: string } }>;
    };
    const storedEvidence = stored.steps[0]?.providerEvidence;
    if (storedEvidence === undefined) throw new Error("stored run lacked finalized evidence");
    storedEvidence.providerEvidenceId = hash("9");
    const contradictoryStore: DeploymentRunStore = {
      get: async () => stored as never,
      create: async () => {
        throw new Error("unexpected create");
      },
      save: async () => {
        throw new Error("unexpected save");
      },
    };
    const resumed = harness({
      source: artifact.source,
      store: contradictoryStore,
      runtime: runtimeFactory(runtimeState),
    });
    const args = resumeArguments().map((argument) =>
      argument === "RUN_ID" ? artifact.plan.planId : argument,
    );
    expect(await runCli(args, resumed.io)).toBe(1);
    expect(JSON.parse(resumed.stderr()).error.code).toBe("run_provider_mismatch");
    expect(runtimeState.observations).toBe(1);
  });

  it("requires every reviewed requirement signer before reachable multichain pending recovery", async () => {
    const artifact = await planArtifact([1, 2]);
    const runtimeState = state();
    const reviewRuntime = runtimeFactory(runtimeState)({
      chains: [
        { chainId: 1, url: "http://127.0.0.1:8545" },
        { chainId: 2, url: "http://127.0.0.1:9545" },
      ],
      privateKeys: new Map([
        [1, PRIVATE_KEY],
        [2, PRIVATE_KEY],
      ]),
      confirmations: 1,
    });
    const reviewer = createMoesi({ observer: reviewRuntime.observer });
    const executionReview = await reviewer.reviewExecution({
      plan: artifact.plan,
      provider: reviewRuntime.provider,
    });
    const firstStep = artifact.plan.steps.find(({ chainId }) => chainId === 1);
    if (firstStep === undefined) throw new Error("missing first-chain step");
    const record = parseDeploymentRunRecord({
      version: "moesi.deployment-run/v1",
      runId: artifact.plan.planId,
      revision: 0,
      plan: artifact.plan,
      executionReview,
      providerId: "viem",
      steps: artifact.plan.steps.map((step) =>
        step.chainId === 1
          ? {
              stepId: step.id,
              chainId: step.chainId,
              phase: "finalized",
              reference: { providerId: "viem", chainId: 1, reference: REFERENCE },
              providerEvidence: {
                chainId: 1,
                sender: SENDER,
                calls: [step.call],
                providerEvidenceId: TX_HASH,
                blockNumber: "101",
                blockHash: hash("2"),
              },
            }
          : { stepId: step.id, chainId: step.chainId, phase: "pending" },
      ),
    });
    const memory = new MemoryDeploymentRunStore();
    await memory.create(record);
    const factory = vi.fn(runtimeFactory(runtimeState));
    const resumed = harness({ source: artifact.source, store: memory, runtime: factory });
    const args = [
      "resume",
      "--run",
      artifact.plan.planId,
      "--provider",
      "viem",
      "--chain",
      "1=http://127.0.0.1:8545",
      "--chain",
      "2=http://127.0.0.1:9545",
      "--signer",
      "2=MOESI_TEST_PRIVATE_KEY",
      "--confirmations",
      "1",
      "--store",
      "./runs",
      "--json",
    ];
    expect(await runCli(args, resumed.io)).toBe(1);
    expect(JSON.parse(resumed.stderr()).error.code).toBe("signer_unavailable");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not demand a signer for pending work behind an ambiguous durable fence", async () => {
    const artifact = await planArtifact([1], 2);
    const runtimeState = state();
    const reviewRuntime = runtimeFactory(runtimeState)({
      chains: [{ chainId: 1, url: "http://127.0.0.1:8545" }],
      privateKeys: new Map([[1, PRIVATE_KEY]]),
      confirmations: 1,
    });
    const reviewer = createMoesi({ observer: reviewRuntime.observer });
    const executionReview = await reviewer.reviewExecution({
      plan: artifact.plan,
      provider: reviewRuntime.provider,
    });
    const record = parseDeploymentRunRecord({
      version: "moesi.deployment-run/v1",
      runId: artifact.plan.planId,
      revision: 1,
      plan: artifact.plan,
      executionReview,
      providerId: "viem",
      steps: artifact.plan.steps.map((step, index) => ({
        stepId: step.id,
        chainId: step.chainId,
        phase: index === 0 ? "submission-requested" : "pending",
      })),
    });
    const memory = new MemoryDeploymentRunStore();
    await memory.create(record);
    const resumed = harness({
      source: artifact.source,
      store: memory,
      runtime: runtimeFactory(runtimeState),
    });
    const args = resumeArguments().map((argument) =>
      argument === "RUN_ID" ? artifact.plan.planId : argument,
    );
    expect(await runCli(args, resumed.io)).toBe(3);
    expect(JSON.parse(resumed.stdout())).toMatchObject({
      runState: "recovery-required",
      result: {
        chains: [{ execution: { kind: "failed", reason: "submission-ambiguous" } }],
      },
    });
    expect(resumed.reads).not.toHaveBeenCalled();
    expect(runtimeState.submissions).toBe(0);
  });

  it("maps SIGINT to a durable stop after the in-flight reference is retained", async () => {
    const artifact = await planArtifact();
    const runtimeState = state();
    const store = new MemoryDeploymentRunStore();
    const preview = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(), preview.io)).toBe(2);
    const reviewId = JSON.parse(preview.stdout()).reviewId as string;

    const accepted = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    runtimeState.onSubmit = () => accepted.signal("SIGINT");
    expect(await runCli(applyArguments(reviewId), accepted.io)).toBe(130);
    expect(JSON.parse(accepted.stdout())).toMatchObject({
      runState: "recovery-required",
      stoppedBy: "SIGINT",
      result: {
        chains: [
          {
            execution: {
              kind: "failed",
              reason: "stop-requested",
              steps: [{ reference: { reference: REFERENCE } }],
            },
          },
        ],
      },
    });
    expect(runtimeState.submissions).toBe(1);
    expect(runtimeState.observations).toBe(0);
    expect(parseDeploymentRunRecord(await store.get(artifact.plan.planId)).steps[0]).toMatchObject({
      phase: "submitted",
      reference: { reference: REFERENCE },
    });
    expect(accepted.signalHandlersRemoved()).toBe(true);
  });

  it("requires the durable confirmation policy and a signer for untouched pending work", async () => {
    const artifact = await planArtifact();
    const runtimeState = state({ observation: "pending" });
    const memory = new MemoryDeploymentRunStore();
    let failFence = true;
    const store: DeploymentRunStore = {
      get: (runId) => memory.get(runId),
      create: (record) => memory.create(record),
      async save(record, options) {
        if (failFence) {
          failFence = false;
          throw new Error("raw fence failure");
        }
        await memory.save(record, options);
      },
    };
    const preview = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(), preview.io)).toBe(2);
    const reviewId = JSON.parse(preview.stdout()).reviewId as string;
    const failedFence = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(reviewId), failedFence.io)).toBe(1);
    expect(JSON.parse(failedFence.stderr()).error.code).toBe("run_store_failed");
    expect(runtimeState.submissions).toBe(0);

    const noSigner = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    const args = resumeArguments(false).map((argument) =>
      argument === "RUN_ID" ? artifact.plan.planId : argument,
    );
    expect(await runCli(args, noSigner.io)).toBe(1);
    expect(JSON.parse(noSigner.stderr()).error.code).toBe("signer_unavailable");
    expect(runtimeState.submissions).toBe(0);

    const wrongPolicy = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    const wrongPolicyArgs = resumeArguments(true, 2).map((argument) =>
      argument === "RUN_ID" ? artifact.plan.planId : argument,
    );
    expect(await runCli(wrongPolicyArgs, wrongPolicy.io)).toBe(1);
    expect(JSON.parse(wrongPolicy.stderr()).error.code).toBe("run_provider_mismatch");
    expect(runtimeState.submissions).toBe(0);
  });

  it("rejects non-canonical plan artifacts, implicit providers, and secret-bearing failures", async () => {
    const artifact = await planArtifact();
    const runtimeState = state({ reviewFailure: "raw provider secret" });
    const store = new MemoryDeploymentRunStore();
    const rawPlan = harness({
      source: JSON.stringify(artifact.plan),
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(), rawPlan.io)).toBe(1);
    expect(JSON.parse(rawPlan.stderr()).error.code).toBe("plan_artifact_invalid");

    const contradictoryPlan = JSON.parse(artifact.source);
    contradictoryPlan.plan.planId = hash("f");
    const invalidPlan = harness({
      source: JSON.stringify(contradictoryPlan),
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(), invalidPlan.io)).toBe(1);
    expect(JSON.parse(invalidPlan.stderr()).error.code).toBe("plan_identity_mismatch");

    const implicit = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    const withoutProvider = applyArguments().filter(
      (argument, index, values) => argument !== "--provider" && values[index - 1] !== "--provider",
    );
    expect(await runCli(withoutProvider, implicit.io)).toBe(1);
    expect(JSON.parse(implicit.stderr()).error.code).toBe("invalid_arguments");

    const failedReview = harness({
      source: artifact.source,
      store,
      runtime: runtimeFactory(runtimeState),
    });
    expect(await runCli(applyArguments(), failedReview.io)).toBe(1);
    expect(JSON.parse(failedReview.stderr()).error.code).toBe("provider_review_failed");
    expect(failedReview.stderr()).not.toContain("raw provider secret");
    expect(failedReview.stderr()).not.toContain(PRIVATE_KEY);
    expect(failedReview.stderr()).not.toContain("rpc-secret");
  });
});
