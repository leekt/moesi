import { closeSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertFleetObservationEvolution,
  type FleetObservationKey,
  type FleetObservationRecord,
  MAX_FLEET_OBSERVATION_BYTES,
  MoesiFleetObservationError,
  normalizeFleetObservationError,
  parseFleetObservationKey,
  parseFleetObservationRecord,
} from "../fleet/observation-record.js";
import type { FleetObservationStore } from "../fleet/observation-store.js";

const STORE_VERSION = "moesi.fleet-observation-store/v1";

/** Node 22.13+ local SQLite store. One row per scope/chain, atomic revisions,
 * bounded lock waits, FULL durability. The parent directory must already exist.
 * This entry point is deliberately separate from browser-safe moesi/fleet. */
export class SqliteFleetObservationStore implements FleetObservationStore {
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(input: { readonly path: string }) {
    let db: DatabaseSync | undefined;
    try {
      const path = input.path;
      if (typeof path !== "string" || !path || path.includes("\0") || path === ":memory:")
        throw new Error();
      const filename = resolve(path);
      try {
        const file = openSync(filename, "wx", 0o600);
        try {
          fsyncSync(file);
        } finally {
          closeSync(file);
        }
        const directory = openSync(dirname(filename), "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!lstatSync(filename).isFile()) throw new Error();
      db = new DatabaseSync(filename);
      db.exec("PRAGMA busy_timeout = 100; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      db.exec("BEGIN IMMEDIATE");
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
        if (tables.length === 0) {
          db.exec(
            "CREATE TABLE moesi_meta (version TEXT NOT NULL); CREATE TABLE observations (scope TEXT NOT NULL, chain_id INTEGER NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY (scope, chain_id)) STRICT;",
          );
          db.prepare("INSERT INTO moesi_meta VALUES (?)").run(STORE_VERSION);
        } else {
          if (!tables.some((table) => (table as { name: unknown }).name === "moesi_meta"))
            throw new MoesiFleetObservationError("unsupported_fleet_observation_version");
          const versions = db.prepare("SELECT version FROM moesi_meta").all() as Record<
            string,
            unknown
          >[];
          if (versions.length !== 1 || versions[0]!.version !== STORE_VERSION)
            throw new MoesiFleetObservationError("unsupported_fleet_observation_version");
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      this.#db = db;
    } catch (error) {
      try {
        db?.close();
      } catch {
        /* Preserve the safe primary diagnostic. */
      }
      throw normalizeFleetObservationError(error);
    }
  }
  async get(input: FleetObservationKey): Promise<FleetObservationRecord | undefined> {
    const key = parseFleetObservationKey(input);
    try {
      this.#assertOpen();
      return this.#get(key);
    } catch (error) {
      throw normalizeFleetObservationError(error);
    }
  }
  async compareAndSwap(
    input: FleetObservationRecord,
    expectedRevision: number | null,
  ): Promise<boolean> {
    const next = parseFleetObservationRecord(input);
    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    )
      throw new MoesiFleetObservationError("fleet_observation_invalid");
    try {
      this.#assertOpen();
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const previous = this.#get(next);
        if ((previous?.revision ?? null) !== expectedRevision) {
          this.#db.exec("ROLLBACK");
          return false;
        }
        assertFleetObservationEvolution(previous, next);
        this.#db
          .prepare(
            "INSERT INTO observations (scope, chain_id, revision, record) VALUES (?, ?, ?, ?) ON CONFLICT (scope, chain_id) DO UPDATE SET revision=excluded.revision, record=excluded.record",
          )
          .run(next.scope, next.chainId, next.revision, JSON.stringify(next));
        this.#db.exec("COMMIT");
        return true;
      } catch (error) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          /* A failed commit may already have ended the transaction. */
        }
        throw error;
      }
    } catch (error) {
      throw normalizeFleetObservationError(error);
    }
  }
  close(): void {
    if (this.#closed) return;
    try {
      this.#db.close();
      this.#closed = true;
    } catch {
      throw new MoesiFleetObservationError("fleet_observation_store_failed");
    }
  }
  #assertOpen() {
    if (this.#closed) throw new Error();
  }
  #get(key: FleetObservationKey): FleetObservationRecord | undefined {
    const row = this.#db
      .prepare(
        "SELECT revision, CASE WHEN length(CAST(record AS BLOB)) <= ? THEN record ELSE NULL END AS record FROM observations WHERE scope=? AND chain_id=?",
      )
      .get(MAX_FLEET_OBSERVATION_BYTES, key.scope, key.chainId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    let record: FleetObservationRecord;
    try {
      if (typeof row.record !== "string") throw new Error();
      record = parseFleetObservationRecord(JSON.parse(row.record));
    } catch (error) {
      if (error instanceof MoesiFleetObservationError) throw error;
      throw new MoesiFleetObservationError("fleet_observation_invalid");
    }
    if (
      record.scope !== key.scope ||
      record.chainId !== key.chainId ||
      record.revision !== row.revision
    )
      throw new MoesiFleetObservationError("fleet_observation_invalid");
    return record;
  }
}
