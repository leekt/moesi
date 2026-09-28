import { mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMoesi,
  type DeploymentRunRecord,
  type DeploymentRunStore,
  type MoesiExecutionProvider,
  type MoesiManifest,
  type MoesiObservationAdapter,
  parseDeploymentRunRecord,
  type ReviewedPlan,
} from "moesi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createFileDeploymentRunStore } from "../src/run-store.js";

const PROVIDER_ID = "file-store-test";
const REVISION_DIGITS = 16;
const address = (byte: string): `0x${string}` => `0x${byte.repeat(40)}`;
const hash = (byte: string): `0x${string}` => `0x${byte.repeat(64)}`;
const SENDER = address("a");
const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const CREATE2_FACTORY_RUNTIME =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

const manifest: MoesiManifest = {
  version: "moesi.manifest/v6",
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
      expectedRuntimeCodeHash: hash("d"),
      configuration: [],
      checks: [],
      storageChecks: [],
    },
  ],
};

const directories: string[] = [];
let initialRecord: DeploymentRunRecord;

beforeAll(async () => {
  initialRecord = await captureInitialRecord();
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("file DeploymentRun store", () => {
  it("reopens the latest fully persisted revision", async () => {
    const directory = await temporaryDirectory();
    const firstProcess = createFileDeploymentRunStore({ directory });
    const requested = submissionRequested(initialRecord);

    await firstProcess.create(initialRecord);
    await firstProcess.save(requested, { expectedRevision: 0 });

    const recreatedProcess = createFileDeploymentRunStore({ directory });
    expect(recreatedProcess).not.toBe(firstProcess);
    expect(parseDeploymentRunRecord(await recreatedProcess.get(initialRecord.runId))).toEqual(
      requested,
    );
    expect((await readdir(directory)).sort()).toEqual([
      revisionName(initialRecord.runId, 0),
      revisionName(initialRecord.runId, 1),
    ]);
  });

  it("refuses to recreate an existing run", async () => {
    const directory = await temporaryDirectory();
    const firstProcess = createFileDeploymentRunStore({ directory });
    const recreatedProcess = createFileDeploymentRunStore({ directory });

    await firstProcess.create(initialRecord);

    await expect(recreatedProcess.create(initialRecord)).rejects.toMatchObject({
      code: "run_store_conflict",
    });
  });

  it("allows exactly one independent store to win the same revision CAS", async () => {
    const directory = await temporaryDirectory();
    const firstProcess = createFileDeploymentRunStore({ directory });
    const secondProcess = createFileDeploymentRunStore({ directory });
    const requested = submissionRequested(initialRecord);
    await firstProcess.create(initialRecord);

    const results = await Promise.allSettled([
      firstProcess.save(requested, { expectedRevision: 0 }),
      secondProcess.save(requested, { expectedRevision: 0 }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "run_store_conflict" }),
      }),
    ]);
    expect(parseDeploymentRunRecord(await firstProcess.get(initialRecord.runId))).toEqual(
      requested,
    );
  });

  it("rejects stale writes and schema-valid non-monotonic evolution", async () => {
    const directory = await temporaryDirectory();
    const store = createFileDeploymentRunStore({ directory });
    const requested = submissionRequested(initialRecord);
    await store.create(initialRecord);
    await store.save(requested, { expectedRevision: 0 });

    await expect(store.save(requested, { expectedRevision: 0 })).rejects.toMatchObject({
      code: "run_store_conflict",
    });

    const unchangedNextRevision = parseDeploymentRunRecord({
      ...requested,
      revision: 2,
    });
    await expect(store.save(unchangedNextRevision, { expectedRevision: 1 })).rejects.toMatchObject({
      code: "run_store_conflict",
    });
    expect(parseDeploymentRunRecord(await store.get(initialRecord.runId))).toEqual(requested);
  });

  it("ignores unpublished same-directory temporary files", async () => {
    const directory = await temporaryDirectory();
    const store = createFileDeploymentRunStore({ directory });
    await store.create(initialRecord);
    await writeFile(join(directory, `.${initialRecord.runId}.interrupted.tmp`), "truncated", {
      mode: 0o600,
    });

    expect(parseDeploymentRunRecord(await store.get(initialRecord.runId))).toEqual(initialRecord);
  });

  it("fails closed on a malformed published filename", async () => {
    const directory = await temporaryDirectory();
    const store = createFileDeploymentRunStore({ directory });
    await store.create(initialRecord);
    await writeFile(join(directory, `${initialRecord.runId}.malformed.json`), "{}\n", {
      mode: 0o600,
    });

    await expect(store.get(initialRecord.runId)).rejects.toMatchObject({
      code: "run_record_invalid",
    });
  });

  it("rejects stale persisted versions with one unsupported-version code", async () => {
    const directory = await temporaryDirectory();
    const store = createFileDeploymentRunStore({ directory });
    await store.create(initialRecord);
    await writeFile(
      join(directory, revisionName(initialRecord.runId, 0)),
      JSON.stringify({ version: "moesi.deployment-run/v2", obsolete: true }),
      { mode: 0o600 },
    );
    await expect(store.get(initialRecord.runId)).rejects.toMatchObject({
      code: "unsupported_run_version",
    });
  });

  it("fails closed when a published revision sequence has a gap", async () => {
    const directory = await temporaryDirectory();
    const store = createFileDeploymentRunStore({ directory });
    await store.create(initialRecord);
    await writeFile(
      join(directory, revisionName(initialRecord.runId, 2)),
      `${JSON.stringify({ ...initialRecord, revision: 2 })}\n`,
      { mode: 0o600 },
    );

    await expect(store.get(initialRecord.runId)).rejects.toMatchObject({
      code: "run_record_invalid",
    });
  });

  it("treats a published revision that vanishes after enumeration as corruption", async () => {
    const directory = await temporaryDirectory();
    const store = createFileDeploymentRunStore({ directory });
    await symlink(
      join(directory, "missing-target"),
      join(directory, revisionName(initialRecord.runId, 0)),
    );

    await expect(store.get(initialRecord.runId)).rejects.toMatchObject({
      code: "run_record_invalid",
    });
  });

  it("returns undefined for a missing valid run id", async () => {
    const directory = await temporaryDirectory();
    const store = createFileDeploymentRunStore({ directory });

    await expect(store.get(initialRecord.runId)).resolves.toBeUndefined();
  });

  it("does not create a directory while reading a missing store", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, "missing");
    const store = createFileDeploymentRunStore({ directory });

    await expect(store.get(initialRecord.runId)).resolves.toBeUndefined();
    expect(await readdir(parent)).toEqual([]);
  });

  it("does not create a directory for a save without an existing run", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, "missing");
    const store = createFileDeploymentRunStore({ directory });

    await expect(
      store.save(submissionRequested(initialRecord), { expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "run_not_found" });
    expect(await readdir(parent)).toEqual([]);
  });

  it("publishes revision files with private permissions", async () => {
    const directory = await temporaryDirectory();
    const store = createFileDeploymentRunStore({ directory });
    await store.create(initialRecord);

    const metadata = await stat(join(directory, revisionName(initialRecord.runId, 0)));
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("creates nested store directories before publishing", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, "nested", "runs");
    const store = createFileDeploymentRunStore({ directory });

    await store.create(initialRecord);
    expect(parseDeploymentRunRecord(await store.get(initialRecord.runId))).toEqual(initialRecord);
  });

  it("rejects a NUL-containing directory at construction", () => {
    expect(() => createFileDeploymentRunStore({ directory: "invalid\0directory" })).toThrow(
      expect.objectContaining({ code: "run_store_required" }),
    );
  });
});

async function captureInitialRecord(): Promise<DeploymentRunRecord> {
  let captured: DeploymentRunRecord | undefined;
  const captureStore: DeploymentRunStore = {
    async get() {
      return captured;
    },
    async create(record) {
      captured = parseDeploymentRunRecord(record);
    },
    async save() {
      throw new Error("stop after the initial record");
    },
  };
  const observer = observationAdapter();
  const client = createMoesi({ observer, runStore: captureStore });
  const plan = await client.plan({ manifest, chains: [1] });
  const provider = executionProvider(plan);
  const executionReview = await client.reviewExecution({ plan, provider });
  const run = client.apply({
    plan,
    provider,
    executionReview,
    observeTiming: { attempts: 1, delayMs: 0 },
  });
  let rejected = false;
  try {
    await run.wait();
  } catch {
    rejected = true;
  }
  if (!rejected || captured === undefined) {
    throw new Error("failed to capture the initial DeploymentRun record");
  }
  return captured;
}

function observationAdapter(): MoesiObservationAdapter {
  return {
    async captureSnapshot() {
      return { blockNumber: "100", blockHash: hash("1") };
    },
    async readCode({ address: target }) {
      return target === CREATE2_FACTORY ? CREATE2_FACTORY_RUNTIME : "0x";
    },
    async readCall() {
      return "0x";
    },
    async checkBlockAncestry() {
      return true;
    },
  };
}

function executionProvider(plan: ReviewedPlan): MoesiExecutionProvider {
  return {
    id: PROVIDER_ID,
    async review() {
      return {
        providerId: PROVIDER_ID,
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
      return { providerId: PROVIDER_ID, planId: plan.planId, binding: {} };
    },
    async submit({ action }) {
      return { providerId: PROVIDER_ID, chainId: action.chainId, reference: hash("8") };
    },
    async observe() {
      return { status: "pending" };
    },
  };
}

function submissionRequested(record: DeploymentRunRecord): DeploymentRunRecord {
  const firstStep = record.steps[0];
  if (firstStep === undefined) throw new Error("test plan must contain one step");
  return parseDeploymentRunRecord({
    ...record,
    revision: record.revision + 1,
    steps: record.steps.map((step, index) =>
      index === 0
        ? { stepId: firstStep.stepId, chainId: firstStep.chainId, phase: "submission-requested" }
        : step,
    ),
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "moesi-cli-run-store-"));
  directories.push(directory);
  return directory;
}

function revisionName(runId: string, revision: number): string {
  return `${runId}.${String(revision).padStart(REVISION_DIGITS, "0")}.json`;
}
