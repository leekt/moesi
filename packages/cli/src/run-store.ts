import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertDeploymentRunEvolution,
  type DeploymentRunRecord,
  type DeploymentRunStore,
  MoesiRunError,
  parseDeploymentRunId,
  parseDeploymentRunRecord,
  type SaveDeploymentRunOptions,
} from "moesi";

const REVISION_DIGITS = 16;

export interface CreateFileDeploymentRunStoreInput {
  readonly directory: string;
}

/**
 * A process-safe local DeploymentRun store for the Node CLI host.
 *
 * Each complete revision is fsynced to a private temporary file, then published
 * with one same-directory hard link. The final link is create-if-absent, so two
 * processes contending on the same next revision have exactly one winner and
 * never need a crash-stale lock file.
 */
export function createFileDeploymentRunStore(
  input: CreateFileDeploymentRunStoreInput,
): DeploymentRunStore {
  let directory: string;
  try {
    if (
      typeof input.directory !== "string" ||
      input.directory.length === 0 ||
      input.directory.includes("\0")
    ) {
      throw new Error("directory is invalid");
    }
    directory = resolve(input.directory);
  } catch {
    throw new MoesiRunError("run_store_required", "run store directory is invalid");
  }
  return new FileDeploymentRunStore(directory);
}

class FileDeploymentRunStore implements DeploymentRunStore {
  #ready: Promise<void> | undefined;

  constructor(private readonly directory: string) {}

  async get(runIdInput: string): Promise<unknown | undefined> {
    const runId = parseRunId(runIdInput);
    try {
      return await loadLatestIfPresent(this.directory, runId);
    } catch (error) {
      throw normalizeStoreFailure(error);
    }
  }

  async create(recordInput: DeploymentRunRecord): Promise<void> {
    const record = parseRecord(recordInput);
    if (record.revision !== 0) {
      throw new MoesiRunError(
        "run_record_invalid",
        "a new deployment run must start at revision 0",
      );
    }
    try {
      await this.#ensureDirectory();
      const revisions = await listRevisions(this.directory, record.runId);
      if (revisions.length > 0) {
        throw new MoesiRunError("run_store_conflict", "deployment run already exists");
      }
      await publishRevision(this.directory, record);
    } catch (error) {
      throw normalizeStoreFailure(error);
    }
  }

  async save(recordInput: DeploymentRunRecord, options: SaveDeploymentRunOptions): Promise<void> {
    const next = parseRecord(recordInput);
    const expectedRevision = parseExpectedRevision(options);
    if (next.revision !== expectedRevision + 1) {
      throw new MoesiRunError("run_store_conflict", "deployment run revision is stale");
    }
    try {
      const current = await loadLatestIfPresent(this.directory, next.runId);
      if (current === undefined) {
        throw new MoesiRunError("run_not_found", "deployment run does not exist");
      }
      if (current.revision !== expectedRevision) {
        throw new MoesiRunError("run_store_conflict", "deployment run revision is stale");
      }
      assertDeploymentRunEvolution(current, next);
      await publishRevision(this.directory, next);
    } catch (error) {
      throw normalizeStoreFailure(error);
    }
  }

  async #ensureDirectory(): Promise<void> {
    this.#ready ??= ensureDurableDirectory(this.directory);
    await this.#ready;
  }
}

function parseRunId(input: unknown): string {
  try {
    return parseDeploymentRunId(input);
  } catch {
    throw new MoesiRunError("run_record_invalid", "deployment run id is invalid");
  }
}

function parseRecord(input: unknown): DeploymentRunRecord {
  try {
    return parseDeploymentRunRecord(input);
  } catch {
    throw new MoesiRunError("run_record_invalid", "deployment run record is invalid");
  }
}

function parseExpectedRevision(options: SaveDeploymentRunOptions): number {
  try {
    const value = Reflect.get(options, "expectedRevision");
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("revision is invalid");
    }
    return value;
  } catch {
    throw new MoesiRunError("run_store_conflict", "deployment run revision is stale");
  }
}

async function loadLatestIfPresent(
  directory: string,
  runId: string,
): Promise<DeploymentRunRecord | undefined> {
  let revisions: number[];
  try {
    revisions = await listRevisions(directory, runId);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  return loadRevisions(directory, runId, revisions);
}

async function loadRevisions(
  directory: string,
  runId: string,
  revisions: readonly number[],
): Promise<DeploymentRunRecord | undefined> {
  if (revisions.length === 0) return undefined;
  let previous: DeploymentRunRecord | undefined;
  for (const revision of revisions) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(revisionPath(directory, runId, revision), "utf8"));
    } catch {
      throw new CorruptRunStore();
    }
    const record = parseStoredRecord(value);
    if (record.runId !== runId || record.revision !== revision) throw new CorruptRunStore();
    if (previous !== undefined) {
      try {
        assertDeploymentRunEvolution(previous, record);
      } catch {
        throw new CorruptRunStore();
      }
    }
    previous = record;
  }
  return previous;
}

async function listRevisions(directory: string, runId: string): Promise<number[]> {
  const names = await readdir(directory);
  const prefix = `${runId}.`;
  const revisions: number[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^[0-9]{16}\.json$/.test(suffix)) throw new CorruptRunStore();
    const digits = suffix.slice(0, REVISION_DIGITS);
    const revision = Number(digits);
    if (!Number.isSafeInteger(revision) || formatRevision(revision) !== digits) {
      throw new CorruptRunStore();
    }
    revisions.push(revision);
  }
  revisions.sort((left, right) => left - right);
  for (let index = 0; index < revisions.length; index += 1) {
    if (revisions[index] !== index) throw new CorruptRunStore();
  }
  return revisions;
}

async function ensureDurableDirectory(directory: string): Promise<void> {
  const missing: string[] = [];
  let cursor = directory;
  while (true) {
    try {
      const metadata = await stat(cursor);
      if (!metadata.isDirectory()) throw new Error("run store path is not a directory");
      break;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }

  for (const path of missing.reverse()) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    }
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new Error("run store path is not a directory");
    // The new directory's name belongs to its parent. Persist that entry before
    // any record write is allowed to cross the external side-effect boundary.
    await syncDirectory(dirname(path));
    await syncDirectory(path);
  }
}

async function publishRevision(directory: string, record: DeploymentRunRecord): Promise<void> {
  const temporaryPath = join(directory, `.${record.runId}.${randomUUID()}.tmp`);
  const targetPath = revisionPath(directory, record.runId, record.revision);
  let handle: FileHandle | undefined;
  try {
    // Fail before publication when this filesystem cannot provide the directory
    // durability primitive the store contract requires.
    await syncDirectory(directory);
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") {
        throw new MoesiRunError("run_store_conflict", "deployment run revision is stale");
      }
      throw error;
    }
    await syncDirectory(directory);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function revisionPath(directory: string, runId: string, revision: number): string {
  return join(directory, `${runId}.${formatRevision(revision)}.json`);
}

function formatRevision(revision: number): string {
  return String(revision).padStart(REVISION_DIGITS, "0");
}

function parseStoredRecord(value: unknown): DeploymentRunRecord {
  try {
    return parseDeploymentRunRecord(value);
  } catch {
    throw new CorruptRunStore();
  }
}

class CorruptRunStore extends Error {}

function normalizeStoreFailure(error: unknown): MoesiRunError {
  if (error instanceof CorruptRunStore) {
    return new MoesiRunError("run_record_invalid", "deployment run store contains invalid state");
  }
  const code = snapshotRunErrorCode(error);
  if (code === "run_store_conflict") {
    return new MoesiRunError("run_store_conflict", "deployment run store conflict");
  }
  if (code === "run_not_found") {
    return new MoesiRunError("run_not_found", "deployment run does not exist");
  }
  if (code === "run_record_invalid") {
    return new MoesiRunError("run_record_invalid", "deployment run store contains invalid state");
  }
  return new MoesiRunError("run_store_failed", "deployment run store operation failed");
}

function snapshotRunErrorCode(error: unknown): string | null {
  try {
    if (!(error instanceof MoesiRunError)) return null;
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function nodeErrorCode(error: unknown): string | null {
  try {
    if (typeof error !== "object" || error === null) return null;
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
