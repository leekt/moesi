import { keccak256 } from "cetane/utils";
import {
  createMoesi,
  type DeploymentCall,
  MemoryDeploymentRunStore,
  type MoesiExecutionProvider,
  parseDeploymentRunRecord,
} from "moesi";
import { describe, expect, it, vi } from "vitest";
import { type CliIo, runCli } from "../src/command.js";
import { CliError } from "../src/errors.js";
import { createRpcObservationAdapter } from "../src/rpc.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const sender = `0x${"aa".repeat(20)}` as const;
const factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const factoryCode =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
const bindings = [{ chainId: 1, url: "http://127.0.0.1:8545" }];
const common = [
  "--provider",
  "oaath",
  "--oaath-client",
  "./client.mjs",
  "--chain",
  "1=http://127.0.0.1:8545",
  "--store",
  "./runs",
  "--observe-attempts",
  "1",
  "--json",
];
const apply = ["apply", "--plan", "./plan.json", ...common];

async function harness() {
  const state = {
    deployed: false,
    finalized: false,
    route: `oaath-session-erc4337-bundler:${hash(8).slice(2)}`,
    blocked: false,
  };
  let call: DeploymentCall | undefined;
  const block = (n: number) => ({
    number: `0x${n.toString(16)}`,
    hash: hash(n),
    parentHash: hash(n - 1),
  });
  const fetcher: typeof fetch = async (_url, options) => {
    const { id, method, params } = JSON.parse(String(options?.body));
    const result =
      method === "eth_chainId"
        ? "0x1"
        : method === "eth_getBlockByNumber"
          ? block(params[0] === "latest" ? (state.deployed ? 3 : 1) : Number(BigInt(params[0])))
          : method === "eth_getBlockByHash"
            ? block(Number(BigInt(params[0])))
            : method === "eth_getCode"
              ? params[0] === factory
                ? factoryCode
                : state.deployed
                  ? "0x6000"
                  : "0x"
              : "0x";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  const plan = await createMoesi({ observer: createRpcObservationAdapter(bindings, fetcher) }).plan(
    {
      chains: [1],
      manifest: {
        version: "moesi.manifest/v8",
        contracts: [
          {
            kind: "managed",
            id: "counter",
            deployment: {
              kind: "create2-factory-v1",
              requiresRuntime: [],
              salt: hash(12),
              initCode: "0x6000",
              value: "0",
            },
            expectedRuntimeCodeHash: keccak256("0x6000"),
            checks: [],
            storageChecks: [],
            configuration: [],
          },
        ],
      },
    },
  );
  const submit = vi.fn(async ({ action }: Parameters<MoesiExecutionProvider["submit"]>[0]) => {
    call = action.step.call;
    state.deployed = true;
    return {
      providerId: "oaath",
      chainId: 1,
      reference: `oaath-op-v1:${hash(8).slice(2)}:${hash(9)}`,
    };
  });
  const provider: MoesiExecutionProvider = {
    id: "oaath",
    async review() {
      return {
        providerId: "oaath",
        status: state.blocked ? "blocked" : "supported",
        chains: [
          {
            chainId: 1,
            sender,
            accountId: "account",
            route: state.route,
            signer: "owner" as const,
            signerReason: "caller-supplied-eoa",
            fallback: null,
            enforcement: { calls: "onchain", expiry: "onchain", operationCount: "onchain" },
          },
        ],
        reasons: state.blocked
          ? [{ code: "oaath_grant_required", chainId: null, stepId: null }]
          : [],
      };
    },
    async prepare({ plan }) {
      return { providerId: "oaath", planId: plan.planId, binding: null };
    },
    submit,
    async submitBatch({ prepared, operation }) {
      return submit({
        prepared,
        action: { planId: operation.planId, chainId: operation.chainId, step: operation.steps[0]! },
      });
    },
    async observe() {
      if (!state.finalized || !call) return { status: "pending" };
      return {
        status: "finalized",
        finalized: {
          chainId: 1,
          sender,
          calls: [call],
          providerEvidenceId: hash(9),
          submissionRoute: "transaction",
          blockNumber: "2",
          blockHash: hash(2),
        },
      };
    },
  };
  const authorize = vi.fn(async () => ({
    status: "requested" as const,
    grantReference: hash(8).slice(2),
  }));
  const close = vi.fn(async () => {});
  const factory_ = vi.fn(async () => ({ provider, authorize, close }));
  const store = new MemoryDeploymentRunStore();
  const output: string[] = [];
  const errors: string[] = [];
  const readEnv = vi.fn(() => undefined);
  const cetane = vi.fn(() => {
    throw new Error("unexpected_cetane");
  });
  const io: CliIo = {
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    async readFile() {
      return JSON.stringify({ version: "moesi.cli-plan/v7", plan });
    },
    fetch: fetcher,
    createRunStore: () => store,
    createOAAthRuntime: factory_,
    createCetaneRuntime: cetane,
    readEnv,
  };
  return {
    state,
    plan,
    submit,
    authorize,
    close,
    factory: factory_,
    store,
    output,
    errors,
    io,
    readEnv,
    cetane,
  };
}

describe("explicit CLI OAAth selection", () => {
  it("preserves permission failure when runtime cleanup also fails", async () => {
    const h = await harness();
    h.authorize.mockRejectedValue(new CliError("oaath_permission_failed", "private decision"));
    h.close.mockRejectedValue(new Error("private cleanup"));
    expect(
      await runCli(
        [
          "authorize",
          "--plan",
          "p.json",
          "--provider",
          "oaath",
          "--oaath-client",
          "client.mjs",
          "--json",
        ],
        h.io,
      ),
    ).toBe(1);
    expect(h.output).toEqual([]);
    expect(h.errors.map((line) => JSON.parse(line))).toEqual([
      { version: "moesi.cli-warning/v1", warning: { code: "runtime_cleanup_failed" } },
      { version: "moesi.cli-error/v2", error: { code: "oaath_permission_failed" } },
    ]);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("preserves granted permission and one output artifact when cleanup fails", async () => {
    const h = await harness();
    h.close.mockRejectedValue(new Error("private cleanup"));
    expect(
      await runCli(
        [
          "authorize",
          "--plan",
          "p.json",
          "--provider",
          "oaath",
          "--oaath-client",
          "client.mjs",
          "--json",
        ],
        h.io,
      ),
    ).toBe(0);
    expect(h.output).toHaveLength(1);
    expect(JSON.parse(h.output[0]!)).toMatchObject({ status: "requested" });
    expect(h.errors.map((line) => JSON.parse(line))).toEqual([
      { version: "moesi.cli-warning/v1", warning: { code: "runtime_cleanup_failed" } },
    ]);
    expect(h.authorize).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "preserves review disposition with blocked=%s when cleanup fails",
    async (blocked) => {
      const h = await harness();
      h.state.blocked = blocked;
      h.close.mockRejectedValue(new Error("private cleanup"));
      expect(await runCli(apply, h.io)).toBe(blocked ? 3 : 2);
      expect(h.output).toHaveLength(1);
      expect(JSON.parse(h.output[0]!)).toMatchObject({
        provider: { status: blocked ? "blocked" : "supported" },
      });
      expect(h.errors.map((line) => JSON.parse(line))).toEqual([
        { version: "moesi.cli-warning/v1", warning: { code: "runtime_cleanup_failed" } },
      ]);
      expect(h.submit).not.toHaveBeenCalled();
    },
  );

  it("preserves acceptance mismatch and scrubbed human cleanup guidance", async () => {
    const h = await harness();
    await runCli(apply, h.io);
    const review = JSON.parse(h.output.pop()!);
    h.state.route = `oaath-session-erc4337-bundler:${hash(7).slice(2)}`;
    h.close.mockRejectedValue(new Error("private cleanup"));
    expect(
      await runCli(
        [...apply.filter((arg) => arg !== "--json"), "--accept-review", review.reviewId],
        h.io,
      ),
    ).toBe(1);
    expect(h.output).toEqual([]);
    expect(h.errors.join("")).toContain("execution_review_mismatch");
    expect(h.errors.join("")).toContain("warning: runtime_cleanup_failed");
    expect(h.errors.join("")).toContain("saved Run");
    expect(h.errors.join("")).not.toContain("private");
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("keeps submitted and resumed results authoritative when cleanup fails", async () => {
    const h = await harness();
    await runCli(apply, h.io);
    const review = JSON.parse(h.output.pop()!);
    h.close.mockRejectedValue(new Error("private cleanup"));
    expect(await runCli([...apply, "--accept-review", review.reviewId], h.io)).toBe(3);
    expect(h.output).toHaveLength(1);
    const applied = JSON.parse(h.output.pop()!);
    const before = parseDeploymentRunRecord(await h.store.get(applied.result.runId));
    expect(before.operations[0]?.phase).toBe("submitted");
    h.state.finalized = true;
    expect(await runCli(["resume", "--run", before.runId, ...common], h.io)).toBe(0);
    expect(h.output).toHaveLength(1);
    expect(JSON.parse(h.output.pop()!).result.status).toBe("converged");
    const after = parseDeploymentRunRecord(await h.store.get(before.runId));
    expect(after.operations[0]).toMatchObject({
      reference: (before.operations[0] as { reference: unknown }).reference,
    });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(3);
    expect(h.errors.map((line) => JSON.parse(line))).toEqual([
      { version: "moesi.cli-warning/v1", warning: { code: "runtime_cleanup_failed" } },
      { version: "moesi.cli-warning/v1", warning: { code: "runtime_cleanup_failed" } },
    ]);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "preserves the %s exit code and submitted reference after cleanup failure",
    async (signal) => {
      const h = await harness();
      await runCli(apply, h.io);
      const review = JSON.parse(h.output.pop()!);
      h.close.mockRejectedValue(new Error("private cleanup"));
      let stop: ((value: "SIGINT" | "SIGTERM") => void) | undefined;
      const remove = vi.fn();
      const submit = h.submit.getMockImplementation()!;
      h.submit.mockImplementation(async (input) => {
        const reference = await submit(input);
        stop!(signal);
        return reference;
      });
      const io: CliIo = {
        ...h.io,
        installSignalHandlers(handler) {
          stop = handler;
          return remove;
        },
      };
      expect(await runCli([...apply, "--accept-review", review.reviewId], io)).toBe(
        signal === "SIGINT" ? 130 : 143,
      );
      expect(h.output).toHaveLength(1);
      const output = JSON.parse(h.output[0]!);
      expect(output.stoppedBy).toBe(signal);
      const record = parseDeploymentRunRecord(await h.store.get(output.result.runId));
      expect(record.operations[0]).toMatchObject({ phase: "submitted" });
      expect(h.submit).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalled();
      expect(h.errors.map((line) => JSON.parse(line))).toEqual([
        { version: "moesi.cli-warning/v1", warning: { code: "runtime_cleanup_failed" } },
      ]);
    },
  );

  it("binds packing to approval and rejects attempts to change it during recovery", async () => {
    const h = await harness();
    expect(await runCli([...apply, "--packing", "per-step"], h.io)).toBe(2);
    const first = JSON.parse(h.output.pop() ?? "");
    expect(first.packing).toBe("per-step");
    expect(await runCli([...apply, "--packing", "per-chain"], h.io)).toBe(2);
    const second = JSON.parse(h.output.pop() ?? "");
    expect(second.packing).toBe("per-chain");
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(
      await runCli([...apply, "--packing", "per-chain", "--accept-review", first.reviewId], h.io),
    ).toBe(1);
    expect(h.submit).not.toHaveBeenCalled();
    expect(
      await runCli(["resume", "--run", h.plan.planId, ...common, "--packing", "per-step"], h.io),
    ).toBe(1);
  });

  it("reviews, accepts and recovers the same reference without new consent or submission", async () => {
    const h = await harness();
    expect(await runCli(apply, h.io)).toBe(2);
    const review = JSON.parse(h.output.pop() ?? "");
    expect(review).toMatchObject({
      version: "moesi.cli-execution-review/v10",
      atomicity: "one-operation-per-chain",
      packing: "per-chain",
      operations: [{ id: "chain-1", chainId: 1, stepIds: ["counter:deploy"] }],
      provider: { providerId: "oaath" },
    });
    expect(h.submit).not.toHaveBeenCalled();
    expect(await runCli([...apply, "--accept-review", review.reviewId], h.io)).toBe(3);
    const applied = JSON.parse(h.output.pop() ?? "");
    const id = applied.result.runId;
    const retained = parseDeploymentRunRecord(await h.store.get(id));
    h.state.finalized = true;
    expect(await runCli(["resume", "--run", id, ...common], h.io)).toBe(0);
    expect(JSON.parse(h.output.pop() ?? "").result.status).toBe("converged");
    const restored = parseDeploymentRunRecord(await h.store.get(id));
    const retainedStep = retained.operations[0];
    if (retainedStep?.phase !== "submitted") throw new Error("missing_reference");
    expect(restored.operations[0]).toMatchObject({ reference: retainedStep.reference });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(3);
    expect(h.readEnv).not.toHaveBeenCalled();
    expect(h.cetane).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it("only the authorize command requests permission and closes its client", async () => {
    const h = await harness();
    expect(
      await runCli(
        [
          "authorize",
          "--provider",
          "oaath",
          "--plan",
          "p.json",
          "--oaath-client",
          "client.mjs",
          "--json",
        ],
        h.io,
      ),
    ).toBe(0);
    expect(h.authorize).toHaveBeenCalledWith(h.plan, "per-chain");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
    expect(JSON.parse(h.output[0] ?? "")).toMatchObject({
      version: "moesi.cli-permission/v2",
      providerId: "oaath",
      planId: h.plan.planId,
      status: "requested",
    });
  });

  it("closes blocked reviews and rejects changed authority", async () => {
    const h = await harness();
    expect(await runCli(apply, h.io)).toBe(2);
    const review = JSON.parse(h.output.pop() ?? "");
    h.state.route = `oaath-session-erc4337-bundler:${hash(7).slice(2)}`;
    expect(await runCli([...apply, "--accept-review", review.reviewId], h.io)).toBe(1);
    expect(h.errors.join("")).toContain("execution_review_mismatch");
    h.state.blocked = true;
    expect(await runCli(apply, h.io)).toBe(3);
    expect(h.close).toHaveBeenCalledTimes(3);
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["--signer", "1=SECRET_KEY"],
    ["--confirmations", "1"],
    ["--oaath-client", "duplicate.mjs"],
  ])("rejects mixed or repeated flags %j before loading authority", async (...extra) => {
    const h = await harness();
    expect(await runCli([...apply, ...extra], h.io)).toBe(1);
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.readEnv).not.toHaveBeenCalled();
  });

  it("rejects a provider change on resume before loading either provider", async () => {
    const h = await harness();
    await runCli(apply, h.io);
    const review = JSON.parse(h.output.pop() ?? "");
    await runCli([...apply, "--accept-review", review.reviewId], h.io);
    const applied = JSON.parse(h.output.pop() ?? "");
    expect(
      await runCli(
        [
          "resume",
          "--run",
          applied.result.runId,
          "--provider",
          "cetane",
          "--confirmations",
          "1",
          "--chain",
          "1=http://127.0.0.1:8545",
          "--store",
          "./runs",
          "--json",
        ],
        h.io,
      ),
    ).toBe(1);
    expect(h.errors.join("")).toContain("run_provider_mismatch");
    expect(h.cetane).not.toHaveBeenCalled();
    expect(h.factory).toHaveBeenCalledTimes(2);
  });
});
