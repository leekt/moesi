import { keccak256 } from "cetane/utils";
import { createMoesi } from "../create-moesi.js";
import { MoesiPlanningError } from "../errors.js";
import { compareAscii, deepFreeze, hashCanonical, snapshotArray } from "../internal.js";
import { parseManifest } from "../manifest/parse.js";
import { compileResourceChecks } from "../manifest/semantic.js";
import { resourceChainBinding } from "../manifest/target.js";
import { observationCause, throwIfObservationStopped } from "../observation/failure.js";
import {
  captureChainSnapshot,
  observeCall,
  observeRuntimeCode,
  observeStorage,
} from "../observation/observe.js";
import { readConcurrently } from "../observation/parallel.js";
import {
  type ConfigurationPeerObservation,
  configurationReadiness,
  observeConfigurationPeers,
} from "../observation/peers.js";
import { bindObservationSignal } from "../observation/signal.js";
import type {
  CallReadRequest,
  ChainSnapshot,
  MoesiObservationAdapter,
  StorageReadRequest,
} from "../observation/types.js";
import { compileConfigurationCaller, deriveResourceAddress } from "../planning/resource.js";
import { MAX_PLAN_CHAINS } from "../planning/types.js";
import { parityReadKey, parseFleetBaseline } from "./baseline.js";
import {
  type CheckFleetParityInput,
  type FleetBaselineCell,
  type FleetParityCell,
  type FleetParityChain,
  type FleetParityDifference,
  type FleetParityObservedCell,
  type FleetParityReadObservation,
  type FleetParityResult,
  type FleetParityRuntime,
  MOESI_FLEET_BASELINE_VERSION,
  MOESI_FLEET_PARITY_VERSION,
  MoesiFleetParityError,
} from "./parity-types.js";

/** Compare resolved declarations and re-observe both sides at identical, explicit pins. */
export async function checkFleetParity(input: CheckFleetParityInput): Promise<FleetParityResult> {
  const baseline = parseFleetBaseline(input.baseline);
  const manifest = parseManifest(input.manifest);
  const selected = snapshotArray(input.chains);
  if (
    !selected ||
    selected.length < 1 ||
    selected.length > MAX_PLAN_CHAINS ||
    selected.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) ||
    new Set(selected).size !== selected.length
  )
    throw new MoesiFleetParityError("invalid_parity_request");
  const chains = (selected as number[]).sort((a, b) => a - b);
  for (const resource of manifest.contracts) {
    const bound = resourceChainBinding(resource);
    if (bound !== null && chains.some((chainId) => chainId !== bound))
      throw new MoesiFleetParityError("invalid_parity_request");
  }
  if (chains.some((chainId) => !baseline.cells.some((cell) => cell.chainId === chainId)))
    throw new MoesiFleetParityError("baseline_chain_missing");
  const candidate = parseFleetBaseline({
    version: MOESI_FLEET_BASELINE_VERSION,
    cells: chains.flatMap((chainId) =>
      manifest.contracts.map((resource): FleetBaselineCell => {
        const checks = compileResourceChecks(resource);
        return {
          chainId,
          resourceId: resource.id,
          kind: resource.kind,
          address: deriveResourceAddress(resource),
          expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
          configuration:
            resource.kind === "managed"
              ? resource.configuration.map((row) => ({
                  id: row.id,
                  caller: compileConfigurationCaller(resource),
                  readData: row.readData,
                  expectedResult: row.expectedResult,
                  after: row.after ?? [],
                }))
              : [],
          checks: checks.checks.map(({ id, target, caller, readData, expectedResult }) => ({
            id,
            target,
            caller,
            readData,
            expectedResult,
          })),
          storageChecks: checks.storageChecks.map(({ id, slot, expectedWord }) => ({
            id,
            slot,
            expectedWord,
          })),
        };
      }),
    ),
  });
  const observer = fixedPins(bindObservationSignal(input.observer, input.signal));
  const reads = new PinnedReads(observer);
  const client = createMoesi({ observer });
  const results: FleetParityChain[] = [];
  for (const chainId of chains) {
    const oldCells = baseline.cells.filter((cell) => cell.chainId === chainId);
    const newCells = candidate.cells.filter((cell) => cell.chainId === chainId);
    let snapshot: ChainSnapshot | null = null;
    let candidatePlan: FleetParityChain["candidatePlan"] = null;
    let error: FleetParityChain["error"];
    try {
      const plan = await client.plan({
        manifest,
        chains: [chainId],
        ...(input.signal ? { signal: input.signal } : {}),
      });
      snapshot = plan.snapshots[0]!;
      candidatePlan = { planId: plan.planId, disposition: plan.disposition };
    } catch (failure) {
      throwIfObservationStopped(failure);
      if (
        !(failure instanceof MoesiPlanningError) ||
        !["snapshot_unreadable", "invalid_snapshot"].includes(failure.code)
      )
        throw failure;
      const cause = observationCause(failure);
      error = {
        code: failure.code as "snapshot_unreadable" | "invalid_snapshot",
        ...(cause ? { cause } : {}),
      };
    }
    const peers = [
      ...new Map(
        [...oldCells, ...newCells]
          .flatMap((cell) => cell.configuration.flatMap((row) => row.after))
          .map((peer) => [hashCanonical(peer), peer]),
      ).values(),
    ];
    const observedPeers = snapshot ? await observeConfigurationPeers(observer, peers) : [];
    const ids = [...new Set([...oldCells, ...newCells].map((cell) => cell.resourceId))].sort(
      compareAscii,
    );
    const cells = await readConcurrently(ids, async (resourceId): Promise<FleetParityCell> => {
      const previous = oldCells.find((cell) => cell.resourceId === resourceId);
      const next = newCells.find((cell) => cell.resourceId === resourceId);
      const [oldState, newState] = await Promise.all([
        previous ? observeCell(previous, snapshot, observedPeers, reads) : null,
        next ? observeCell(next, snapshot, observedPeers, reads) : null,
      ]);
      return {
        resourceId,
        baseline: oldState,
        candidate: newState,
        differences: differences(oldState, newState),
      };
    });
    results.push({
      chainId,
      snapshot,
      candidatePlan,
      peers: observedPeers,
      cells,
      ...(error ? { error } : {}),
    });
  }
  const unreadable = results.some(
    (chain) =>
      chain.snapshot === null ||
      chain.cells.some((cell) =>
        [cell.baseline, cell.candidate].some(
          (side) =>
            side &&
            (side.liveState === "unreadable" ||
              [...side.configuration, ...side.checks, ...side.storageChecks].some(
                (row) => row.observation.kind !== "readable",
              )),
        ),
      ),
  );
  return deepFreeze({
    version: MOESI_FLEET_PARITY_VERSION,
    baselineHash: hashCanonical(baseline),
    manifestHash: manifest.manifestHash,
    status: unreadable
      ? "unreadable"
      : results.some((chain) => chain.cells.some((cell) => cell.differences.length > 0))
        ? "different"
        : "match",
    chains: results,
  });
}

function fixedPins(source: MoesiObservationAdapter): MoesiObservationAdapter {
  const pins = new Map<number, Promise<ChainSnapshot>>();
  return {
    async captureSnapshot(chainId) {
      let pending = pins.get(chainId);
      if (!pending) {
        pending = captureChainSnapshot(source, chainId);
        pins.set(chainId, pending);
      }
      const { blockNumber, blockHash } = await pending;
      return Object.freeze({ blockNumber, blockHash });
    },
    readCode: (request) => source.readCode(request),
    readCall: (request) => source.readCall(request),
    ...(source.readStorage
      ? {
          readStorage: (
            request: Parameters<NonNullable<MoesiObservationAdapter["readStorage"]>>[0],
          ) => source.readStorage!(request),
        }
      : {}),
    checkBlockAncestry: (request) => source.checkBlockAncestry(request),
  };
}

class PinnedReads {
  readonly runtimes = new Map<string, Promise<FleetParityRuntime>>();
  readonly values = new Map<string, Promise<FleetParityReadObservation>>();
  constructor(readonly observer: MoesiObservationAdapter) {}
  runtime(cell: FleetBaselineCell, snapshot: ChainSnapshot | null): Promise<FleetParityRuntime> {
    if (!snapshot) return Promise.resolve({ kind: "unreadable", reason: "snapshot-unreadable" });
    const request = { chainId: cell.chainId, address: cell.address, snapshot };
    const key = hashCanonical(request);
    let pending = this.runtimes.get(key);
    if (!pending) {
      pending = observeRuntimeCode(this.observer, request).then(
        (value): FleetParityRuntime =>
          value.kind === "unreadable"
            ? value
            : value.code === "0x"
              ? { kind: "missing" }
              : { kind: "deployed", runtimeCodeHash: keccak256(value.code) },
      );
      this.runtimes.set(key, pending);
    }
    return pending;
  }
  async read(
    cell: FleetBaselineCell,
    row:
      | FleetBaselineCell["configuration"][number]
      | FleetBaselineCell["checks"][number]
      | FleetBaselineCell["storageChecks"][number],
    runtime: FleetParityRuntime,
    snapshot: ChainSnapshot | null,
  ): Promise<FleetParityReadObservation> {
    if (!snapshot) return { kind: "unreadable", reason: "snapshot-unreadable" };
    if (runtime.kind === "missing") return { kind: "not-deployed" };
    if (runtime.kind === "unreadable")
      return {
        kind: "unreadable",
        reason: "runtime-unreadable",
        ...(runtime.cause ? { cause: runtime.cause } : {}),
      };
    const request: CallReadRequest | StorageReadRequest =
      "slot" in row
        ? { chainId: cell.chainId, address: cell.address, slot: row.slot, snapshot }
        : {
            chainId: cell.chainId,
            target: "target" in row ? row.target : cell.address,
            data: row.readData,
            caller: row.caller,
            snapshot,
          };
    const key = hashCanonical(request);
    let pending = this.values.get(key);
    if (!pending) {
      pending =
        "slot" in request
          ? observeStorage(this.observer, request).then((result) =>
              result.kind === "unreadable" ? result : { kind: "readable", value: result.word },
            )
          : observeCall(this.observer, request).then((result) =>
              result.kind === "unreadable" ? result : { kind: "readable", value: result.result },
            );
      this.values.set(key, pending);
    }
    return pending;
  }
}

async function observeCell(
  cell: FleetBaselineCell,
  snapshot: ChainSnapshot | null,
  peers: readonly ConfigurationPeerObservation[],
  reads: PinnedReads,
): Promise<FleetParityObservedCell> {
  const runtime = await reads.runtime(cell, snapshot);
  const [configuration, checks, storageChecks] = await Promise.all([
    readConcurrently(cell.configuration, async (row) => ({
      ...row,
      readiness: configurationReadiness(row.after, peers),
      observation: await reads.read(cell, row, runtime, snapshot),
    })),
    readConcurrently(cell.checks, async (row) => ({
      ...row,
      observation: await reads.read(cell, row, runtime, snapshot),
    })),
    readConcurrently(cell.storageChecks, async (row) => ({
      ...row,
      observation: await reads.read(cell, row, runtime, snapshot),
    })),
  ]);
  const rows = [...configuration, ...checks, ...storageChecks];
  const liveState =
    runtime.kind === "unreadable" ||
    rows.some((row) => row.observation.kind === "unreadable") ||
    configuration.some((row) => row.readiness === "blocked-peer")
      ? "unreadable"
      : runtime.kind === "missing"
        ? "missing"
        : configuration.some((row) => row.readiness === "pending-peer")
          ? "pending"
          : runtime.runtimeCodeHash !== cell.expectedRuntimeCodeHash ||
              rows.some(
                (row) =>
                  row.observation.kind === "readable" &&
                  row.observation.value !==
                    ("expectedWord" in row ? row.expectedWord : row.expectedResult),
              )
            ? "drifted"
            : "converged";
  return { ...cell, runtime, configuration, checks, storageChecks, liveState };
}

function differences(
  baseline: FleetParityObservedCell | null,
  candidate: FleetParityObservedCell | null,
): FleetParityDifference[] {
  if (!baseline) return [{ code: "resource_added" }];
  if (!candidate) return [{ code: "resource_missing" }];
  const result: FleetParityDifference[] = [];
  if (baseline.kind !== candidate.kind) result.push({ code: "resource_kind_mismatch" });
  if (baseline.address !== candidate.address) result.push({ code: "address_mismatch" });
  if (baseline.expectedRuntimeCodeHash !== candidate.expectedRuntimeCodeHash)
    result.push({ code: "runtime_hash_mismatch" });
  if (
    baseline.runtime.kind !== "unreadable" &&
    candidate.runtime.kind !== "unreadable" &&
    hashCanonical(baseline.runtime) !== hashCanonical(candidate.runtime)
  )
    result.push({ code: "runtime_observation_mismatch" });
  for (const [property, readKind] of [
    ["configuration", "configuration"],
    ["checks", "call"],
    ["storageChecks", "storage"],
  ] as const) {
    const oldRows = new Map(baseline[property].map((row) => [parityReadKey(readKind, row), row]));
    const newRows = new Map(candidate[property].map((row) => [parityReadKey(readKind, row), row]));
    for (const key of [...new Set([...oldRows.keys(), ...newRows.keys()])].sort(compareAscii)) {
      const previous = oldRows.get(key);
      const next = newRows.get(key);
      const detail = {
        readKind,
        ...(previous ? { baselineId: previous.id } : {}),
        ...(next ? { candidateId: next.id } : {}),
      };
      if (!previous || !next) {
        result.push({ ...detail, code: previous ? "read_missing" : "read_added" });
        continue;
      }
      if (
        ("expectedWord" in previous ? previous.expectedWord : previous.expectedResult) !==
        ("expectedWord" in next ? next.expectedWord : next.expectedResult)
      )
        result.push({ ...detail, code: "expected_result_mismatch" });
      if (
        "after" in previous &&
        "after" in next &&
        hashCanonical(previous.after) !== hashCanonical(next.after)
      )
        result.push({ ...detail, code: "peer_requirements_mismatch" });
      if (
        previous.observation.kind === "readable" &&
        next.observation.kind === "readable" &&
        previous.observation.value !== next.observation.value
      )
        result.push({ ...detail, code: "read_observation_mismatch" });
    }
  }
  return result;
}
