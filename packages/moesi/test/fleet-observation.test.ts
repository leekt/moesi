import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keccak256, stringToHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertFleetObservationEvolution,
  type FleetObservationRecord,
  type FleetObservationStore,
  loadFleetObservation,
  MemoryFleetObservationStore,
  MoesiFleetObservationError,
  observeFleetChain,
  parseFleetObservationRecord,
  parseFleetReadEvidence,
} from "../src/fleet/index.js";
import type { FleetReadEvidence } from "../src/fleet/types.js";
import type { MoesiManifest } from "../src/manifest/types.js";
import { SqliteFleetObservationStore } from "../src/node/index.js";
import { MoesiObservationError } from "../src/observation/failure.js";
import type { MoesiObservationAdapter } from "../src/observation/types.js";
import { testAddress, testHash, testManifest } from "./fixtures.js";

const key = { scope: "fleet", chainId: 1 };
const manifest = testManifest({ runtimeHash: keccak256("0x6000") });
function observer(overrides: Partial<MoesiObservationAdapter> = {}): MoesiObservationAdapter {
  return {
    async captureSnapshot() {
      return { blockNumber: "10", blockHash: testHash("a") };
    },
    async readCode() {
      return "0x6000";
    },
    async readCall() {
      return "0x";
    },
    async checkBlockAncestry() {
      return true;
    },
    ...overrides,
  };
}
function scan(
  store: FleetObservationStore,
  overrides: Partial<Parameters<typeof observeFleetChain>[0]> & {
    manifest?: MoesiManifest;
    reads?: readonly FleetReadEvidence[];
  } = {},
) {
  const { manifest: desired = manifest, reads = [], ...options } = overrides;
  return observeFleetChain({
    ...key,
    store,
    observer: observer(),
    definitionHash: keccak256(stringToHex(JSON.stringify(desired))),
    prepare: async () => ({ manifest: desired, reads }),
    ...options,
  });
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), "moesi-fleet-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "observations.sqlite");
  const store = new SqliteFleetObservationStore({ path });
  cleanup.push(() => store.close());
  return { path, store };
}

describe("durable fleet observations", () => {
  it("reserves before compilation so an older compiler cannot overwrite a newer definition", async () => {
    const store = new MemoryFleetObservationStore();
    const entered = barrier();
    const gate = barrier();
    const older = scan(store, {
      definitionHash: testHash("1"),
      prepare: async () => {
        expect((await store.get(key))?.state).toBe("pending");
        expect((await store.get(key))?.manifestHash).toBeNull();
        entered.release();
        await gate.wait;
        return { manifest, reads: [] };
      },
    });
    await entered.wait;
    const newer = await scan(store, { definitionHash: testHash("2") });
    gate.release();
    expect(await older).toEqual({ outcome: "superseded", record: newer.record });
    expect(newer.record.snapshot?.definitionHash).toBe(testHash("2"));
  });
  it("durably records compilation failure and retains the prior definition's complete evidence", async () => {
    const store = new MemoryFleetObservationStore();
    const before = await scan(store);
    const result = await scan(store, {
      definitionHash: testHash("3"),
      prepare: async () => {
        throw new Error("secret compiler diagnostics");
      },
    });
    expect(result.record.state).toBe("failed");
    expect(result.record.manifestHash).toBeNull();
    expect(result.record.failure).toEqual({
      code: "compilation_failed",
      cause: null,
      observation: null,
    });
    expect(result.record.snapshot).toEqual(before.record.snapshot);
    expect(result.record.snapshot?.definitionHash).not.toBe(result.record.definitionHash);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("cancels a blocked compiler without permitting its later completion to publish", async () => {
    const store = new MemoryFleetObservationStore();
    const entered = barrier();
    const gate = barrier();
    const controller = new AbortController();
    const request = scan(store, {
      signal: controller.signal,
      prepare: async (context) => {
        expect(context.signal).toBe(controller.signal);
        entered.release();
        await gate.wait;
        return { manifest, reads: [] };
      },
    });
    await entered.wait;
    controller.abort();
    const failed = await request;
    expect(failed.record.failure?.code).toBe("observation_aborted");
    expect(failed.record.manifestHash).toBeNull();
    const recovered = await scan(store);
    gate.release();
    await Promise.resolve();
    expect(await store.get(key)).toEqual(recovered.record);
  });
  it("round-trips immutable pinned evidence and reloads after restart with no RPC", async () => {
    const { path, store } = await database();
    const reads = [
      {
        chainId: 1,
        address: testAddress("a"),
        caller: testAddress("b"),
        data: "0x1234" as const,
        result: "0x06" as const,
        snapshot: { chainId: 1, blockNumber: "8", blockHash: testHash("b") },
      },
    ];
    const source = observer({
      captureSnapshot: vi.fn(async () => {
        throw new Error("must reuse compilation pin");
      }),
      readCode: vi.fn(async (request) => {
        expect(request.snapshot.blockHash).toBe(testHash("b"));
        return "0x6000";
      }),
    });
    const result = await scan(store, { reads, observer: source });
    expect(result.record.state).toBe("complete");
    expect(result.record.snapshot?.plan.disposition).toBe("converged");
    expect(source.captureSnapshot).not.toHaveBeenCalled();
    store.close();
    const reopened = new SqliteFleetObservationStore({ path });
    cleanup.push(() => reopened.close());
    const loaded = await loadFleetObservation(reopened, key);
    expect(loaded).toEqual(result.record);
    expect(loaded?.snapshot?.reads).toEqual(reads);
    expect(Object.isFrozen(loaded?.snapshot?.plan.cells)).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("retains prior evidence on failed snapshots and marks a changed manifest explicitly", async () => {
    const store = new MemoryFleetObservationStore();
    const first = await scan(store);
    const cause = {
      attempts: [{ endpoint: 0, category: "timeout" as const, rpcCode: null, httpStatus: null }],
    };
    const result = await scan(store, {
      manifest: testManifest({ id: "new" }),
      observer: observer({
        async captureSnapshot() {
          throw new MoesiObservationError("observation_failed", cause);
        },
      }),
    });
    expect(result.record.state).toBe("failed");
    expect(result.record.failure).toEqual({ code: "observation_failed", cause, observation: null });
    expect(result.record.snapshot).toEqual(first.record.snapshot);
    expect(result.record.manifestHash).not.toBe(result.record.snapshot?.plan.manifestHash);
  });
  it("cannot publish an older scan after a newer scan starts, even after clock rollback", async () => {
    const { path, store } = await database();
    const other = new SqliteFleetObservationStore({ path });
    cleanup.push(() => other.close());
    const entered = barrier();
    const blocked = barrier();
    vi.spyOn(Date, "now").mockReturnValue(200);
    const older = scan(store, {
      observer: observer({
        async readCode() {
          entered.release();
          await blocked.wait;
          return "0x6000";
        },
      }),
    });
    await entered.wait;
    vi.spyOn(Date, "now").mockReturnValue(100);
    const newer = await scan(other, { manifest: testManifest({ id: "changed" }) });
    blocked.release();
    const stale = await older;
    expect(stale.outcome).toBe("superseded");
    expect(stale.record).toEqual(newer.record);
    expect(stale.record.revision).toBe(2);
    expect(stale.record.startedAt).toBe(100);
  });
  it("returns the newer pending record if the old completion loses its revision", async () => {
    const store = new MemoryFleetObservationStore();
    const oldEntered = barrier();
    const oldGate = barrier();
    const newEntered = barrier();
    const newGate = barrier();
    const older = scan(store, {
      observer: observer({
        async captureSnapshot() {
          oldEntered.release();
          await oldGate.wait;
          return { blockNumber: "1", blockHash: testHash("a") };
        },
      }),
    });
    await oldEntered.wait;
    const newer = scan(store, {
      observer: observer({
        async captureSnapshot() {
          newEntered.release();
          await newGate.wait;
          return { blockNumber: "2", blockHash: testHash("b") };
        },
      }),
    });
    await newEntered.wait;
    oldGate.release();
    const stale = await older;
    expect(stale.outcome).toBe("superseded");
    expect(stale.record.state).toBe("pending");
    newGate.release();
    expect((await newer).record.state).toBe("complete");
  });
  it("records unreadability instead of reporting RPC failures as missing or healthy", async () => {
    const store = new MemoryFleetObservationStore();
    const previous = await scan(store);
    const result = await scan(store, {
      observer: observer({
        async readCode() {
          throw new Error("secret-provider-url");
        },
      }),
    });
    expect(result.record.state).toBe("failed");
    expect(result.record.failure?.observation?.plan.cells[0]?.status.kind).toBe("unreadable");
    expect(result.record.snapshot).toEqual(previous.record.snapshot);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("isolates malformed persisted rows and chain failures", async () => {
    const { path, store } = await database();
    await scan(store);
    await scan(store, { chainId: 2 });
    const db = new DatabaseSync(path);
    db.prepare("UPDATE observations SET record=? WHERE chain_id=1").run("{not-json");
    db.close();
    await expect(loadFleetObservation(store, key)).rejects.toMatchObject({
      code: "fleet_observation_invalid",
    });
    expect((await loadFleetObservation(store, { ...key, chainId: 2 }))?.state).toBe("complete");
    const results = await Promise.allSettled([scan(store), scan(store, { chainId: 2 })]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  });
  it("marks active cancellation failed while pre-aborted requests do no persistence or RPC", async () => {
    const store = new MemoryFleetObservationStore();
    const first = await scan(store);
    const controller = new AbortController();
    const entered = barrier();
    const request = scan(store, {
      signal: controller.signal,
      observer: observer({
        async captureSnapshot(_chain, options) {
          expect(options?.signal).toBe(controller.signal);
          entered.release();
          await new Promise(() => {});
        },
      }),
    });
    await entered.wait;
    controller.abort("secret-reason");
    const result = await request;
    expect(result.record.failure).toEqual({
      code: "observation_aborted",
      cause: null,
      observation: null,
    });
    expect(result.record.snapshot).toEqual(first.record.snapshot);
    const source = observer({ captureSnapshot: vi.fn() });
    await expect(
      scan(store, { signal: controller.signal, observer: source }),
    ).rejects.toMatchObject({ code: "observation_aborted" });
    expect(source.captureSnapshot).not.toHaveBeenCalled();
    expect((await store.get(key))?.revision).toBe(result.record.revision);
  });
  it("does not return a candidate when persistence or its authoritative reload fails", async () => {
    const memory = new MemoryFleetObservationStore();
    let saves = 0;
    await expect(
      scan({
        get: (key) => memory.get(key),
        async compareAndSwap(next, revision) {
          if (++saves === 2) throw new Error("secret SQL");
          return memory.compareAndSwap(next, revision);
        },
      }),
    ).rejects.toMatchObject({
      code: "fleet_observation_store_failed",
      message: "fleet_observation_store_failed",
    });
    expect((await memory.get(key))?.state).toBe("pending");
    await expect(
      scan({
        async get() {
          return undefined;
        },
        async compareAndSwap() {
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: "fleet_observation_store_failed" });
  });
  it("rejects version, changed-key, contradictory-pin, incomplete and getter-bearing evidence", async () => {
    const record = (await scan(new MemoryFleetObservationStore())).record;
    expect(() => parseFleetObservationRecord({ version: "moesi.fleet-observation/v1" })).toThrow(
      "unsupported_fleet_observation_version",
    );
    expect(() => parseFleetObservationRecord({ ...record, chainId: 2 })).toThrow(
      "fleet_observation_invalid",
    );
    expect(() => parseFleetObservationRecord({ ...record, snapshot: null })).toThrow(
      "fleet_observation_invalid",
    );
    const getter = vi.fn(() => record.snapshot);
    expect(() =>
      parseFleetObservationRecord({
        ...record,
        get snapshot() {
          return getter();
        },
      }),
    ).toThrow("fleet_observation_invalid");
    expect(getter).not.toHaveBeenCalled();
    const read = {
      chainId: 1,
      address: testAddress("a"),
      caller: testAddress("b"),
      data: "0x",
      result: "0x",
      snapshot: { chainId: 1, blockNumber: "10", blockHash: testHash("b") },
    };
    expect(() =>
      parseFleetObservationRecord({ ...record, snapshot: { ...record.snapshot, reads: [read] } }),
    ).toThrow("fleet_observation_invalid");
    expect(() => parseFleetReadEvidence([read, read])).toThrow("fleet_observation_invalid");
    await expect(
      loadFleetObservation(
        {
          async get() {
            return record;
          },
          async compareAndSwap() {
            return true;
          },
        },
        { scope: "other", chainId: 1 },
      ),
    ).rejects.toMatchObject({ code: "fleet_observation_invalid" });
  });
  it("rejects illegal transitions and keeps only one row per chain", async () => {
    const { path, store } = await database();
    const record = (await scan(store)).record;
    expect(() =>
      assertFleetObservationEvolution(record, { ...record, revision: record.revision + 1 }),
    ).toThrow("fleet_observation_invalid");
    await expect(
      store.compareAndSwap({ ...record, revision: 20 }, record.revision),
    ).rejects.toMatchObject({ code: "fleet_observation_invalid" });
    expect(await store.compareAndSwap(record, null)).toBe(false);
    for (let i = 0; i < 4; i++) await scan(store);
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT count(*) AS count FROM observations").get()).toEqual({ count: 1 });
    db.prepare("UPDATE moesi_meta SET version=?").run("moesi.fleet-observation-store/v0");
    db.close();
    expect(() => new SqliteFleetObservationStore({ path })).toThrow(
      "unsupported_fleet_observation_version",
    );
  });
  it("preserves committed state on close and rejects later operations with safe codes", async () => {
    const { store } = await database();
    await scan(store);
    store.close();
    store.close();
    await expect(store.get(key)).rejects.toMatchObject({ code: "fleet_observation_store_failed" });
  });
  it("persists unknown peers as failure and shares a source/peer pin", async () => {
    const store = new MemoryFleetObservationStore();
    const peer = {
      chainId: 1,
      address: testAddress("c"),
      expectedRuntimeCodeHash: keccak256("0x6000"),
    };
    const captureSnapshot = vi.fn(async () => ({ blockNumber: "10", blockHash: testHash("a") }));
    const result = await scan(store, {
      manifest: testManifest({
        runtimeHash: keccak256("0x6000"),
        configuration: [
          {
            id: "route",
            readData: "0x12345678",
            expectedResult: "0x01",
            writeData: "0x87654321",
            value: "0",
            after: [peer],
          },
        ],
      }),
      observer: observer({
        captureSnapshot,
        async readCode({ address }) {
          if (address === peer.address) throw new Error("private");
          return "0x6000";
        },
        async readCall() {
          return "0x01";
        },
      }),
    });
    expect(captureSnapshot).toHaveBeenCalledTimes(1);
    expect(result.record.state).toBe("failed");
    expect(result.record.snapshot).toBeNull();
    expect(result.record.failure?.observation?.plan.peers[0]?.status.kind).toBe("unreadable");
  });
  it("sanitizes forged storage diagnostics", async () => {
    const bad = new MoesiFleetObservationError("fleet_observation_invalid");
    Object.defineProperty(bad, "code", { value: "secret database path" });
    await expect(
      loadFleetObservation(
        {
          async get() {
            throw bad;
          },
          async compareAndSwap() {
            return false;
          },
        },
        key,
      ),
    ).rejects.toMatchObject({ message: "fleet_observation_store_failed" });
  });
  it("does not allow a failed attempt to erase prior evidence", async () => {
    const store = new MemoryFleetObservationStore();
    const record = (await scan(store)).record;
    const pending = parseFleetObservationRecord({
      ...record,
      revision: 2,
      manifestHash: null,
      state: "pending",
      completedAt: null,
    });
    expect(await store.compareAndSwap(pending, 1)).toBe(true);
    const failed = {
      ...pending,
      revision: 3,
      state: "failed",
      completedAt: 100,
      snapshot: null,
      failure: { code: "observation_failed", cause: null, observation: null },
    } as FleetObservationRecord;
    await expect(store.compareAndSwap(failed, 2)).rejects.toMatchObject({
      code: "fleet_observation_invalid",
    });
  });
});
