import type { Hex } from "cetane";
import { hashCanonical } from "../internal.js";
import { parseManifest } from "../manifest/parse.js";
import type { MoesiManifest } from "../manifest/types.js";
import {
  MoesiObservationError,
  observationCause,
  withObservationAbort,
} from "../observation/failure.js";
import { captureChainSnapshot } from "../observation/observe.js";
import { bindObservationSignal } from "../observation/signal.js";
import type { MoesiObservationAdapter, SnapshotReference } from "../observation/types.js";
import { createPlan } from "../planning/plan.js";
import {
  type FleetObservationKey,
  type FleetObservationRecord,
  incompleteFleetPlan,
  MOESI_FLEET_OBSERVATION_VERSION,
  MoesiFleetObservationError,
  parseFleetObservationKey,
  parseFleetObservationRecord,
  parseFleetReadEvidence,
} from "./observation-record.js";
import { type FleetObservationStore, loadFleetObservation } from "./observation-store.js";
import type { FleetReadEvidence } from "./types.js";

export interface ObserveFleetChainInput extends FleetObservationKey {
  /** Stable hash of the desired authoring definition, before its live reads. */
  readonly definitionHash: Hex;
  /** Runs only after this scan reserves its durable revision. */
  readonly prepare: (context: {
    readonly observer: MoesiObservationAdapter;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly manifest: MoesiManifest; readonly reads: readonly FleetReadEvidence[] }>;
  readonly observer: MoesiObservationAdapter;
  readonly store: FleetObservationStore;
  readonly signal?: AbortSignal;
}
export interface ObserveFleetChainResult {
  readonly outcome: "committed" | "superseded";
  /** Always reloaded from storage, never an uncommitted candidate. */
  readonly record: FleetObservationRecord;
}

/** Persist a single-chain plan with compiler read provenance. A failed chain
 * retains its prior snapshot; independent calls may scan other chains. */
export async function observeFleetChain(
  input: ObserveFleetChainInput,
): Promise<ObserveFleetChainResult> {
  const key = parseFleetObservationKey({ scope: input.scope, chainId: input.chainId });
  let prepare: ObserveFleetChainInput["prepare"];
  let definitionHash: Hex;
  try {
    prepare = input.prepare;
    definitionHash = input.definitionHash;
    if (
      typeof prepare !== "function" ||
      typeof definitionHash !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(definitionHash)
    )
      throw new Error();
  } catch {
    throw new MoesiFleetObservationError("fleet_observation_invalid");
  }
  const signal = input.signal;
  const observer = Object.freeze(bindObservationSignal(snapshotObserver(input.observer), signal));
  const store = snapshotStore(input.store);
  abort(signal);
  let pending: FleetObservationRecord | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await loadFleetObservation(store, key);
    abort(signal);
    const candidate = parseFleetObservationRecord({
      version: MOESI_FLEET_OBSERVATION_VERSION,
      ...key,
      revision: (previous?.revision ?? -1) + 1,
      definitionHash,
      manifestHash: null,
      state: "pending",
      startedAt: Date.now(),
      completedAt: null,
      failure: null,
      snapshot: previous?.snapshot ?? null,
    });
    if (await swap(store, candidate, previous?.revision ?? null)) {
      pending = candidate;
      break;
    }
  }
  if (!pending) throw new MoesiFleetObservationError("fleet_observation_conflict");

  let next: FleetObservationRecord;
  let manifestHash: Hex | null = null;
  try {
    abort(signal);
    const prepared = await withObservationAbort(signal, () =>
      prepare(Object.freeze({ observer, ...(signal ? { signal } : {}) })),
    );
    abort(signal);
    const manifest = parseManifest(prepared.manifest);
    const reads = parseFleetReadEvidence(prepared.reads);
    manifestHash = manifest.manifestHash;
    // Reuse compiler pins, and capture any other chain only once, including
    // chains that are both a source and a peer. All reads keep exact hashes.
    const pins = new Map<number, Promise<SnapshotReference>>(
      reads.map((read) => [
        read.chainId,
        Promise.resolve({
          blockNumber: read.snapshot.blockNumber,
          blockHash: read.snapshot.blockHash,
        }),
      ]),
    );
    const pinned: MoesiObservationAdapter = {
      captureSnapshot(chainId) {
        let pin = pins.get(chainId);
        if (!pin) {
          pin = captureChainSnapshot(observer, chainId).then(({ blockNumber, blockHash }) => ({
            blockNumber,
            blockHash,
          }));
          pins.set(chainId, pin);
        }
        return pin;
      },
      readCode: (request) => observer.readCode(request),
      readCall: (request) => observer.readCall(request),
      ...(observer.readStorage
        ? {
            readStorage: (
              request: Parameters<NonNullable<MoesiObservationAdapter["readStorage"]>>[0],
            ) => observer.readStorage!(request),
          }
        : {}),
      checkBlockAncestry: (request) => observer.checkBlockAncestry(request),
    };
    const plan = await createPlan({ manifest, chains: [key.chainId], observer: pinned });
    abort(signal);
    const completedAt = Date.now();
    const incomplete = incompleteFleetPlan(plan);
    const observation = { definitionHash, plan, reads, observedAt: completedAt };
    next = parseFleetObservationRecord({
      ...pending,
      manifestHash,
      revision: pending.revision + 1,
      completedAt,
      ...(incomplete
        ? {
            state: "failed",
            failure: { code: "observation_failed", cause: incomplete.cause ?? null, observation },
          }
        : { state: "complete", snapshot: observation }),
    });
  } catch (error) {
    next = parseFleetObservationRecord({
      ...pending,
      manifestHash,
      revision: pending.revision + 1,
      state: "failed",
      completedAt: Date.now(),
      failure: {
        code:
          signal?.aborted ||
          (error instanceof MoesiObservationError && error.code === "observation_aborted")
            ? "observation_aborted"
            : manifestHash === null
              ? "compilation_failed"
              : "observation_failed",
        cause: observationCause(error),
        observation: null,
      },
    });
  }
  const committed = await swap(store, next, pending.revision);
  const record = await loadFleetObservation(store, key);
  if (!record || record.revision < next.revision)
    throw new MoesiFleetObservationError("fleet_observation_store_failed");
  if (
    committed &&
    record.revision === next.revision &&
    hashCanonical(record) !== hashCanonical(next)
  )
    throw new MoesiFleetObservationError("fleet_observation_store_failed");
  return Object.freeze({
    outcome: committed && record.revision === next.revision ? "committed" : "superseded",
    record,
  });
}

function abort(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new MoesiObservationError("observation_aborted");
}
function snapshotObserver(input: MoesiObservationAdapter): MoesiObservationAdapter {
  try {
    const methods = Object.fromEntries(
      ["captureSnapshot", "readCode", "readCall", "readStorage", "checkBlockAncestry"].flatMap(
        (name) => {
          const method = Reflect.get(input, name) as unknown;
          if (name === "readStorage" && method === undefined) return [];
          if (typeof method !== "function") throw new Error();
          return [[name, (...args: unknown[]) => Reflect.apply(method, input, args)]];
        },
      ),
    );
    return Object.freeze(methods) as unknown as MoesiObservationAdapter;
  } catch {
    throw new MoesiObservationError("invalid_observer_configuration");
  }
}
function snapshotStore(input: FleetObservationStore): FleetObservationStore {
  try {
    const get = input.get;
    const compareAndSwap = input.compareAndSwap;
    if (typeof get !== "function" || typeof compareAndSwap !== "function") throw new Error();
    return Object.freeze({
      get: (key: FleetObservationKey) =>
        Reflect.apply(get, input, [key]) as ReturnType<FleetObservationStore["get"]>,
      compareAndSwap: (record: FleetObservationRecord, revision: number | null) =>
        Reflect.apply(compareAndSwap, input, [record, revision]) as ReturnType<
          FleetObservationStore["compareAndSwap"]
        >,
    });
  } catch {
    throw new MoesiFleetObservationError("fleet_observation_store_failed");
  }
}
async function swap(
  store: FleetObservationStore,
  next: FleetObservationRecord,
  expected: number | null,
): Promise<boolean> {
  try {
    const result = await store.compareAndSwap(next, expected);
    if (typeof result !== "boolean") throw new Error();
    return result;
  } catch {
    throw new MoesiFleetObservationError("fleet_observation_store_failed");
  }
}
