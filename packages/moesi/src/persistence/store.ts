import { MoesiRunError } from "../errors.js";
import {
  assertDeploymentRunEvolution,
  type DeploymentRunRecord,
  parseDeploymentRunRecord,
} from "../run/record.js";

export interface SaveDeploymentRunOptions {
  /** Revision returned by the last successful create/read/save. */
  readonly expectedRevision: number;
}

/**
 * Caller-owned durable boundary. Reads are untrusted and validated by Moesi;
 * implementations must durably commit before resolving. `create` is an atomic
 * create-if-absent keyed by `runId` and must never overwrite. `save` is an
 * atomic revision compare-and-swap and must never write when `expectedRevision`
 * is stale. A conflict rejects with `MoesiRunError("run_store_conflict", ...)`.
 * These semantics prevent one process from resetting or racing another run.
 */
export interface DeploymentRunStore {
  get(runId: string): Promise<unknown | undefined>;
  /** Atomically create only when this run ID does not already exist. */
  create(record: DeploymentRunRecord): Promise<void>;
  /** Atomically replace only the record at the exact expected revision. */
  save(record: DeploymentRunRecord, options: SaveDeploymentRunOptions): Promise<void>;
}

const parsedStores = new WeakMap<object, DeploymentRunStore>();

/** Snapshot a caller-owned store capability once at the configuration boundary. */
export function parseDeploymentRunStore(input: unknown): DeploymentRunStore {
  try {
    if (typeof input !== "object" || input === null) {
      throw new Error("store is not an object");
    }
    const cached = parsedStores.get(input);
    if (cached) return cached;
    const get = Reflect.get(input, "get") as unknown;
    const create = Reflect.get(input, "create") as unknown;
    const save = Reflect.get(input, "save") as unknown;
    if (typeof get !== "function" || typeof create !== "function" || typeof save !== "function") {
      throw new Error("store methods are invalid");
    }
    const store = Object.freeze({
      get: (runId: string) =>
        Reflect.apply(get, input, [runId]) as ReturnType<DeploymentRunStore["get"]>,
      create: (record: DeploymentRunRecord) =>
        Reflect.apply(create, input, [record]) as ReturnType<DeploymentRunStore["create"]>,
      save: (record: DeploymentRunRecord, options: SaveDeploymentRunOptions) =>
        Reflect.apply(save, input, [record, options]) as ReturnType<DeploymentRunStore["save"]>,
    });
    parsedStores.set(input, store);
    parsedStores.set(store, store);
    return store;
  } catch {
    throw new MoesiRunError("run_store_required", "apply and resume require a DeploymentRunStore");
  }
}

function clone(record: DeploymentRunRecord): unknown {
  return JSON.parse(JSON.stringify(record)) as unknown;
}

/** Ephemeral deterministic store for tests and single-process applications. */
export class MemoryDeploymentRunStore implements DeploymentRunStore {
  readonly #records = new Map<string, unknown>();

  async get(runId: string): Promise<unknown | undefined> {
    const value = this.#records.get(runId);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value)) as unknown;
  }

  async create(input: DeploymentRunRecord): Promise<void> {
    const record = parseDeploymentRunRecord(input);
    if (this.#records.has(record.runId)) {
      throw new MoesiRunError("run_store_conflict", "deployment run already exists");
    }
    this.#records.set(record.runId, clone(record));
  }

  async save(input: DeploymentRunRecord, options: SaveDeploymentRunOptions): Promise<void> {
    const next = parseDeploymentRunRecord(input);
    const currentValue = this.#records.get(next.runId);
    if (currentValue === undefined) {
      throw new MoesiRunError("run_not_found", "deployment run does not exist");
    }
    const current = parseDeploymentRunRecord(currentValue);
    if (options.expectedRevision !== current.revision) {
      throw new MoesiRunError("run_store_conflict", "deployment run revision changed");
    }
    assertDeploymentRunEvolution(current, next);
    this.#records.set(next.runId, clone(next));
  }
}
