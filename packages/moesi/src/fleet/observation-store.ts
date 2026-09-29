import {
  assertFleetObservationEvolution,
  type FleetObservationKey,
  type FleetObservationRecord,
  MoesiFleetObservationError,
  normalizeFleetObservationError,
  parseFleetObservationKey,
  parseFleetObservationRecord,
} from "./observation-record.js";

/** Caller-owned persistence. CAS must atomically validate evolution and durably
 * commit before returning true; false means no write. Reads remain untrusted.
 * Never delete/recreate a key while any worker using it can still complete. */
export interface FleetObservationStore {
  get(key: FleetObservationKey): Promise<unknown | undefined>;
  compareAndSwap(next: FleetObservationRecord, expectedRevision: number | null): Promise<boolean>;
}

export class MemoryFleetObservationStore implements FleetObservationStore {
  readonly #records = new Map<string, FleetObservationRecord>();
  async get(input: FleetObservationKey): Promise<FleetObservationRecord | undefined> {
    return this.#records.get(identity(parseFleetObservationKey(input)));
  }
  async compareAndSwap(
    input: FleetObservationRecord,
    expectedRevision: number | null,
  ): Promise<boolean> {
    const next = parseFleetObservationRecord(input);
    const key = identity(next);
    const previous = this.#records.get(key);
    if ((previous?.revision ?? null) !== expectedRevision) return false;
    assertFleetObservationEvolution(previous, next);
    this.#records.set(key, next);
    return true;
  }
}
function identity(key: FleetObservationKey) {
  return `${key.scope}:${key.chainId}`;
}

/** Load committed evidence without RPC, validating its exact requested key. */
export async function loadFleetObservation(
  store: FleetObservationStore,
  input: FleetObservationKey,
): Promise<FleetObservationRecord | undefined> {
  const key = parseFleetObservationKey(input);
  try {
    const raw = await store.get(key);
    if (raw === undefined) return undefined;
    const record = parseFleetObservationRecord(raw);
    if (record.scope !== key.scope || record.chainId !== key.chainId)
      throw new MoesiFleetObservationError("fleet_observation_invalid");
    return record;
  } catch (error) {
    throw normalizeFleetObservationError(error);
  }
}
