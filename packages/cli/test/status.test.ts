import {
  createMoesi,
  type DeploymentRunRecord,
  type DeploymentRunStore,
  MemoryDeploymentRunStore,
  type MoesiExecutionProvider,
  MoesiRunError,
  type ReviewedPlan,
} from "moesi";
import { describe, expect, it, vi } from "vitest";
import type { CliIo } from "../src/command.js";
import { runCli } from "../src/command.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const CODE = "0x6000" as const;
const RUNTIME_HASH = "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d";
const SENDER = address("a");
const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const CREATE2_FACTORY_RUNTIME =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

interface CapturedStatus {
  readonly runId: string;
  readonly record: DeploymentRunRecord;
}

async function captureStatus(
  outcome: "submission-requested" | "submitted" | "finalized" | "failed",
): Promise<CapturedStatus> {
  const store = new MemoryDeploymentRunStore();
  let reads = 0;
  const client = createMoesi({
    runStore: store,
    observer: {
      async captureSnapshot() {
        return reads === 0
          ? { blockNumber: "100", blockHash: hash("1") }
          : { blockNumber: "200", blockHash: hash("2") };
      },
      async readCode({ address: target }) {
        if (target === CREATE2_FACTORY) return CREATE2_FACTORY_RUNTIME;
        reads += 1;
        return reads === 1 ? "0x" : CODE;
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
    manifest: {
      version: "moesi.manifest/v1",
      contracts: [
        {
          kind: "managed",
          id: "counter",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: hash("c"),
            initCode: "0x60006000",
            value: "0",
          },
          expectedRuntimeCodeHash: RUNTIME_HASH,
          configuration: [],
          checks: [],
          storageChecks: [],
        },
      ],
    },
    chains: [1],
  });
  const provider = fakeProvider(plan, outcome);
  const executionReview = await client.reviewExecution({ plan, provider });
  const run = client.apply({
    plan,
    provider,
    executionReview,
    observeTiming: { attempts: 1, delayMs: 0 },
  });
  await run.wait();
  const value = await store.get(run.runId);
  if (value === undefined) throw new Error("test run was not retained");
  return { runId: run.runId, record: value as DeploymentRunRecord };
}

function fakeProvider(
  plan: ReviewedPlan,
  outcome: "submission-requested" | "submitted" | "finalized" | "failed",
): MoesiExecutionProvider {
  return {
    id: "fake",
    async review() {
      return {
        providerId: "fake",
        status: "supported",
        chains: [
          {
            chainId: 1,
            sender: SENDER,
            accountId: null,
            route: "fake-direct",
            enforcement: {
              calls: "interactive-owner",
              expiry: "not-enforced",
              operationCount: "not-enforced",
            },
          },
        ],
        reasons: [],
      };
    },
    async prepare() {
      return { providerId: "fake", planId: plan.planId, binding: null };
    },
    async submit({ action }) {
      if (outcome === "submission-requested") {
        throw new Error("raw submit detail");
      }
      return { providerId: "fake", chainId: action.chainId, reference: hash("8") };
    },
    async observe() {
      if (outcome === "submitted") return { status: "pending" };
      if (outcome === "failed") return { status: "failed", reason: "raw provider failure" };
      return {
        status: "finalized",
        finalized: {
          chainId: 1,
          sender: SENDER,
          calls: [plan.steps[0]!.call],
          providerEvidenceId: hash("8"),
          blockNumber: "101",
          blockHash: hash("9"),
        },
      };
    },
  };
}

function harness(store: DeploymentRunStore): {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly readFile: ReturnType<typeof vi.fn>;
  readonly fetch: ReturnType<typeof vi.fn>;
} {
  const output: string[] = [];
  const errors: string[] = [];
  const readFile = vi.fn(async () => {
    throw new Error("status must not read a manifest");
  });
  const fetch = vi.fn(async () => {
    throw new Error("status must not contact RPC");
  });
  return {
    io: {
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      readFile,
      fetch,
      createRunStore: () => store,
    },
    stdout: () => output.join(""),
    stderr: () => errors.join(""),
    readFile,
    fetch,
  };
}

function fixedStore(value: unknown | undefined): DeploymentRunStore {
  return {
    async get() {
      return value;
    },
    async create() {
      throw new Error("unused");
    },
    async save() {
      throw new Error("unused");
    },
  };
}

describe("moesi status", () => {
  it.each(["submission-requested", "submitted"] as const)(
    "reports %s as recovery-required without provider or RPC work",
    async (phase) => {
      const captured = await captureStatus(phase);
      const test = harness(fixedStore(captured.record));

      expect(
        await runCli(["status", "--run", captured.runId, "--store", "./runs", "--json"], test.io),
      ).toBe(0);
      const output = JSON.parse(test.stdout());
      expect(output).toMatchObject({
        version: "moesi.cli-status/v1",
        run: {
          runId: captured.runId,
          providerId: "fake",
          executionState: "recovery-required",
          convergence: "not-recorded",
          steps: [{ phase }],
        },
      });
      if (phase === "submitted") {
        expect(output.run.steps[0].reference).toEqual({
          providerId: "fake",
          chainId: 1,
          reference: hash("8"),
        });
      } else {
        expect(output.run.steps[0].reference).toBeNull();
      }
      expect(test.stderr()).toBe("");
      expect(test.readFile).not.toHaveBeenCalled();
      expect(test.fetch).not.toHaveBeenCalled();
    },
  );

  it("renders finalized provider evidence without claiming convergence", async () => {
    const captured = await captureStatus("finalized");
    const test = harness(fixedStore(captured.record));

    expect(await runCli(["status", "--run", captured.runId, "--store", "./runs"], test.io)).toBe(0);
    expect(test.stdout()).toContain("execution finalized");
    expect(test.stdout()).toContain("convergence not-recorded");
    expect(test.stdout()).toContain(`finalized ${hash("8")}`);
    expect(test.stderr()).toBe("");
  });

  it("preserves a terminal structured failure reason", async () => {
    const captured = await captureStatus("failed");
    const test = harness(fixedStore(captured.record));

    expect(
      await runCli(["status", "--run", captured.runId, "--store", "./runs", "--json"], test.io),
    ).toBe(0);
    const output = JSON.parse(test.stdout());
    expect(output.run.executionState).toBe("failed");
    expect(output.run.steps[0]).toMatchObject({
      phase: "failed",
      reason: "invalid-evidence",
    });
    expect(test.stdout()).not.toContain("raw provider failure");
  });

  it("rejects a valid record returned for a different requested run", async () => {
    const captured = await captureStatus("submitted");
    const differentRunId = hash(captured.runId === hash("1") ? "2" : "1");
    const test = harness(fixedStore(captured.record));

    expect(
      await runCli(["status", "--run", differentRunId, "--store", "./runs", "--json"], test.io),
    ).toBe(1);
    expect(JSON.parse(test.stderr()).error.code).toBe("run_record_invalid");
    expect(test.stdout()).toBe("");
  });

  it("returns stable missing and invalid-argument errors", async () => {
    const runId = hash("1");
    const missing = harness(fixedStore(undefined));
    expect(
      await runCli(["status", "--run", runId, "--store", "./runs", "--json"], missing.io),
    ).toBe(1);
    expect(JSON.parse(missing.stderr()).error.code).toBe("run_not_found");

    const invalid = harness(fixedStore(undefined));
    expect(
      await runCli(["status", "--run", "not-a-run", "--store", "./secret/runs"], invalid.io),
    ).toBe(1);
    expect(invalid.stderr()).toBe("MOESI_CLI_ERROR invalid_arguments\n");
    expect(invalid.stderr()).not.toContain("secret");

    const missingStoreValue = harness(fixedStore(undefined));
    expect(
      await runCli(["status", "--run", runId, "--store", "--json"], missingStoreValue.io),
    ).toBe(1);
    expect(JSON.parse(missingStoreValue.stderr()).error.code).toBe("invalid_arguments");
  });

  it("scrubs raw store failures and hostile error accessors", async () => {
    const raw = harness({
      ...fixedStore(undefined),
      async get() {
        throw new Error("/secret/path and raw filesystem body");
      },
    });
    expect(
      await runCli(["status", "--run", hash("1"), "--store", "/secret/path", "--json"], raw.io),
    ).toBe(1);
    expect(JSON.parse(raw.stderr()).error.code).toBe("internal");
    expect(raw.stderr()).not.toContain("secret");

    const hostile = Object.create(MoesiRunError.prototype);
    Object.defineProperty(hostile, "code", {
      get() {
        throw new Error("RAW_STORE_SECRET");
      },
    });
    const accessor = harness({
      ...fixedStore(undefined),
      async get() {
        throw hostile;
      },
    });
    expect(
      await runCli(["status", "--run", hash("1"), "--store", "./runs", "--json"], accessor.io),
    ).toBe(1);
    expect(JSON.parse(accessor.stderr()).error.code).toBe("internal");
    expect(accessor.stderr()).not.toContain("RAW_STORE_SECRET");

    const forged = Object.create(MoesiRunError.prototype);
    Object.defineProperty(forged, "code", { value: "RAW_STORE_SECRET" });
    const arbitraryCode = harness({
      ...fixedStore(undefined),
      async get() {
        throw forged;
      },
    });
    expect(
      await runCli(["status", "--run", hash("1"), "--store", "./runs", "--json"], arbitraryCode.io),
    ).toBe(1);
    expect(JSON.parse(arbitraryCode.stderr()).error.code).toBe("internal");
    expect(arbitraryCode.stderr()).not.toContain("RAW_STORE_SECRET");
  });
});
