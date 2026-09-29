import type { Hex } from "viem";
import { deepFreeze, hashCanonical } from "../internal.js";
import { type ObservationCause, parseObservationCause } from "../observation/failure.js";
import type { ChainSnapshot } from "../observation/types.js";
import { parseReviewedPlan } from "../planning/reviewed-plan.js";
import type { ReviewedPlan } from "../planning/types.js";
import type { FleetReadEvidence } from "./types.js";

export const MOESI_FLEET_OBSERVATION_VERSION = "moesi.fleet-observation/v2" as const;
export type MoesiFleetObservationErrorCode =
  | "unsupported_fleet_observation_version"
  | "fleet_observation_invalid"
  | "fleet_observation_conflict"
  | "fleet_observation_store_failed";
export class MoesiFleetObservationError extends Error {
  constructor(readonly code: MoesiFleetObservationErrorCode) {
    super(code);
    this.name = "MoesiFleetObservationError";
  }
}
/** Never propagate a caller-mutated diagnostic or raw storage exception. */
export function normalizeFleetObservationError(error: unknown): MoesiFleetObservationError {
  try {
    if (error instanceof MoesiFleetObservationError) {
      const code = Object.getOwnPropertyDescriptor(error, "code")?.value as unknown;
      if (
        code === "unsupported_fleet_observation_version" ||
        code === "fleet_observation_invalid" ||
        code === "fleet_observation_conflict"
      )
        return new MoesiFleetObservationError(code);
    }
  } catch {
    /* An unreadable exception is still only a storage failure. */
  }
  return new MoesiFleetObservationError("fleet_observation_store_failed");
}
export interface FleetObservationKey {
  readonly scope: string;
  readonly chainId: number;
}
export interface FleetObservationSnapshot {
  readonly definitionHash: Hex;
  readonly plan: ReviewedPlan;
  /** Exact live values used when compiling this manifest. */
  readonly reads: readonly FleetReadEvidence[];
  readonly observedAt: number;
}
export interface FleetObservationFailure {
  readonly code: "compilation_failed" | "observation_failed" | "observation_aborted";
  readonly cause: ObservationCause | null;
  /** Partial current evidence; prior complete evidence stays in record.snapshot. */
  readonly observation: FleetObservationSnapshot | null;
}
export interface FleetObservationRecord extends FleetObservationKey {
  readonly version: typeof MOESI_FLEET_OBSERVATION_VERSION;
  readonly revision: number;
  readonly definitionHash: Hex;
  /** Null until this attempt has compiled a valid literal manifest. */
  readonly manifestHash: Hex | null;
  /** Complete means all required observations were readable, not converged. */
  readonly state: "pending" | "complete" | "failed";
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly failure: FleetObservationFailure | null;
  /** Retained during pending/failed attempts; may belong to an older manifest. */
  readonly snapshot: FleetObservationSnapshot | null;
}

const invalid = (): never => {
  throw new MoesiFleetObservationError("fleet_observation_invalid");
};
const owned = new WeakSet<object>();
export const MAX_FLEET_OBSERVATION_BYTES = 32 * 1024 * 1024;

/** Bound untrusted JSON and reject accessors before nested codecs see it. */
function capture(
  value: unknown,
  depth = 0,
  budget = { nodes: 500_000, bytes: MAX_FLEET_OBSERVATION_BYTES },
): unknown {
  if (--budget.nodes < 0 || depth > 64) return invalid();
  if (typeof value === "string") {
    budget.bytes -= value.length * 3;
    if (budget.bytes < 0) return invalid();
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "object" || value === null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length) ||
      length > 100_000 ||
      Reflect.ownKeys(descriptors).length !== length + 1
    )
      return invalid();
    return Array.from({ length }, (_, i) => {
      const item = descriptors[String(i)];
      if (!item || !("value" in item)) return invalid();
      return capture(item.value, depth + 1, budget);
    });
  }
  const proto = Object.getPrototypeOf(value);
  if (
    (proto !== null && proto !== Object.prototype) ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")
  )
    return invalid();
  return Object.fromEntries(
    Object.keys(descriptors).map((key) => {
      const item = descriptors[key]!;
      if (!("value" in item) || !item.enumerable) return invalid();
      budget.bytes -= key.length * 3;
      if (budget.bytes < 0) return invalid();
      return [key, capture(item.value, depth + 1, budget)];
    }),
  );
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    return invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value >= Number.MAX_SAFE_INTEGER
  )
    return invalid();
  return value;
}
function hex(value: unknown, size?: number): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[a-f0-9]{2})*$/.test(value) ||
    (size !== undefined && value.length !== 2 + size * 2)
  )
    return invalid();
  return value as Hex;
}
export function parseFleetObservationKey(input: unknown): FleetObservationKey {
  try {
    const value = exact(capture(input), ["scope", "chainId"]);
    if (typeof value.scope !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.scope))
      return invalid();
    return Object.freeze({ scope: value.scope, chainId: integer(value.chainId, 1) });
  } catch {
    return invalid();
  }
}
function pin(input: unknown): ChainSnapshot {
  const value = exact(input, ["chainId", "blockNumber", "blockHash"]);
  if (
    typeof value.blockNumber !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value.blockNumber) ||
    BigInt(value.blockNumber) >= 1n << 256n
  )
    return invalid();
  return {
    chainId: integer(value.chainId, 1),
    blockNumber: value.blockNumber,
    blockHash: hex(value.blockHash, 32),
  };
}
export function parseFleetReadEvidence(input: unknown): readonly FleetReadEvidence[] {
  try {
    const value = capture(input);
    if (!Array.isArray(value) || value.length > 8192) return invalid();
    const identities = new Set<string>();
    const pins = new Map<number, string>();
    return deepFreeze(
      value.map((entry) => {
        const item = exact(entry, ["chainId", "address", "caller", "data", "result", "snapshot"]);
        const read: FleetReadEvidence = {
          chainId: integer(item.chainId, 1),
          address: hex(item.address, 20),
          caller: hex(item.caller, 20),
          data: hex(item.data),
          result: hex(item.result),
          snapshot: pin(item.snapshot),
        };
        if (read.chainId !== read.snapshot.chainId) return invalid();
        const identity = `${read.chainId}:${read.address}:${read.caller}:${read.data}`;
        if (identities.has(identity)) return invalid();
        identities.add(identity);
        const hash = hashCanonical(read.snapshot);
        if (pins.has(read.chainId) && pins.get(read.chainId) !== hash) return invalid();
        pins.set(read.chainId, hash);
        return read;
      }),
    );
  } catch {
    return invalid();
  }
}
export function parseFleetObservationRecord(input: unknown): FleetObservationRecord {
  try {
    if (typeof input === "object" && input !== null && owned.has(input))
      return input as FleetObservationRecord;
    const version =
      typeof input === "object" && input !== null
        ? Object.getOwnPropertyDescriptor(input, "version")
        : undefined;
    if (
      version &&
      "value" in version &&
      typeof version.value === "string" &&
      version.value !== MOESI_FLEET_OBSERVATION_VERSION
    )
      throw new MoesiFleetObservationError("unsupported_fleet_observation_version");
    const value = exact(capture(input), [
      "version",
      "scope",
      "chainId",
      "revision",
      "definitionHash",
      "manifestHash",
      "state",
      "startedAt",
      "completedAt",
      "failure",
      "snapshot",
    ]);
    if (
      value.version !== MOESI_FLEET_OBSERVATION_VERSION ||
      !["pending", "complete", "failed"].includes(value.state as string)
    )
      return invalid();
    const key = parseFleetObservationKey({ scope: value.scope, chainId: value.chainId });
    function parseSnapshot(input: unknown): FleetObservationSnapshot | null {
      if (input === null) return null;
      const source = exact(input, ["definitionHash", "plan", "reads", "observedAt"]);
      const plan = parseReviewedPlan(source.plan as ReviewedPlan);
      if (plan.snapshots.length !== 1 || plan.snapshots[0]!.chainId !== key.chainId)
        return invalid();
      const reads = parseFleetReadEvidence(source.reads);
      const pins = new Map<number, string>();
      for (const item of [
        ...plan.snapshots,
        ...plan.peers.flatMap((peer) => (peer.snapshot ? [peer.snapshot] : [])),
        ...reads.map((read) => read.snapshot),
      ]) {
        const hash = hashCanonical(item);
        if (pins.has(item.chainId) && pins.get(item.chainId) !== hash) return invalid();
        pins.set(item.chainId, hash);
      }
      return {
        definitionHash: hex(source.definitionHash, 32),
        plan,
        reads,
        observedAt: integer(source.observedAt),
      };
    }
    const snapshot = parseSnapshot(value.snapshot);
    if (snapshot && incompleteFleetPlan(snapshot.plan)) return invalid();
    let failure: FleetObservationFailure | null = null;
    if (value.failure !== null) {
      const item = exact(value.failure, ["code", "cause", "observation"]);
      if (
        item.code !== "compilation_failed" &&
        item.code !== "observation_failed" &&
        item.code !== "observation_aborted"
      )
        return invalid();
      failure = {
        code: item.code,
        cause: item.cause === null ? null : parseObservationCause(item.cause),
        observation: parseSnapshot(item.observation),
      };
    }
    const record: FleetObservationRecord = {
      version: MOESI_FLEET_OBSERVATION_VERSION,
      ...key,
      revision: integer(value.revision),
      definitionHash: hex(value.definitionHash, 32),
      manifestHash: value.manifestHash === null ? null : hex(value.manifestHash, 32),
      state: value.state as FleetObservationRecord["state"],
      startedAt: integer(value.startedAt),
      completedAt: value.completedAt === null ? null : integer(value.completedAt),
      failure,
      snapshot,
    };
    if (
      record.state === "pending"
        ? record.completedAt !== null || failure !== null || record.manifestHash !== null
        : record.completedAt === null
    )
      return invalid();
    if (record.state === "failed" ? failure === null : failure !== null) return invalid();
    if (
      record.state === "complete" &&
      (!snapshot ||
        snapshot.definitionHash !== record.definitionHash ||
        snapshot.plan.manifestHash !== record.manifestHash ||
        snapshot.observedAt !== record.completedAt)
    )
      return invalid();
    if (
      failure?.observation &&
      (failure.code !== "observation_failed" ||
        !incompleteFleetPlan(failure.observation.plan) ||
        failure.observation.definitionHash !== record.definitionHash ||
        failure.observation.plan.manifestHash !== record.manifestHash ||
        failure.observation.observedAt !== record.completedAt)
    )
      return invalid();
    if (
      failure?.code === "compilation_failed" &&
      (record.manifestHash !== null || failure.observation !== null)
    )
      return invalid();
    if (failure?.code === "observation_failed" && record.manifestHash === null) return invalid();
    owned.add(record);
    return deepFreeze(record);
  } catch (error) {
    if (
      error instanceof MoesiFleetObservationError &&
      error.code === "unsupported_fleet_observation_version"
    )
      throw error;
    return invalid();
  }
}

/** Every attempt reserves a revision before RPC; only that revision may finish. */
export function assertFleetObservationEvolution(
  previous: FleetObservationRecord | undefined,
  next: FleetObservationRecord,
): void {
  const before = previous === undefined ? undefined : parseFleetObservationRecord(previous);
  const after = parseFleetObservationRecord(next);
  if (!before) {
    if (after.revision !== 0 || after.state !== "pending" || after.snapshot !== null) invalid();
    return;
  }
  if (
    before.scope !== after.scope ||
    before.chainId !== after.chainId ||
    after.revision !== before.revision + 1
  )
    invalid();
  if (after.state === "pending") {
    if (hashCanonical(before.snapshot) !== hashCanonical(after.snapshot)) invalid();
    return;
  }
  if (
    before.state !== "pending" ||
    before.definitionHash !== after.definitionHash ||
    before.startedAt !== after.startedAt
  )
    invalid();
  if (after.state === "failed" && hashCanonical(before.snapshot) !== hashCanonical(after.snapshot))
    invalid();
}

/** Missing and drift are complete observations; failed reads are not. */
export function incompleteFleetPlan(plan: ReviewedPlan) {
  return [...plan.cells, ...plan.peers, ...plan.capabilities]
    .map((item) => item.status)
    .find((status) => status.kind === "unreadable");
}
