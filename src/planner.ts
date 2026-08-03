import { type Address, encodeFunctionData, getCreate2Address, type Hex, keccak256 } from "viem";
import { MoesiPlanningError } from "./errors.js";
import { type MoesiManifest, parseManifest } from "./manifest.js";
import { reviewPlan } from "./reviewed-plan.js";
import type { ChainSnapshot, ResourceCell, ReviewedPlan } from "./types.js";

export interface SnapshotReference {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
}

export interface CodeReadRequest {
  readonly chainId: number;
  readonly address: Address;
  readonly snapshot: ChainSnapshot;
}

export interface CallReadRequest {
  readonly chainId: number;
  readonly target: Address;
  readonly data: Hex;
  readonly snapshot: ChainSnapshot;
}

export interface MoesiObservationAdapter {
  captureSnapshot(chainId: number): Promise<SnapshotReference | unknown>;
  readCode(request: CodeReadRequest): Promise<Hex | unknown>;
  readCall(request: CallReadRequest): Promise<Hex | unknown>;
}

export interface CreateMoesiConfiguration {
  readonly observer: MoesiObservationAdapter;
}

export interface MoesiPlanRequest {
  readonly manifest: MoesiManifest;
  readonly chains: readonly number[];
}

export interface MoesiClient {
  plan(request: MoesiPlanRequest): Promise<ReviewedPlan>;
}

const SNAPSHOT_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const CODE_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;

const CREATE2_FACTORY_ABI = [
  {
    type: "function",
    name: "deploy",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "initCode", type: "bytes" },
    ],
    outputs: [{ name: "deployed", type: "address" }],
  },
] as const;

export function createMoesi(configuration: CreateMoesiConfiguration): MoesiClient {
  return {
    async plan(request) {
      const manifest = parseManifest(request.manifest);
      const chains = parseChains(request.chains);
      const snapshots: ChainSnapshot[] = [];
      for (const chainId of chains) {
        snapshots.push(await captureChainSnapshot(configuration.observer, chainId));
      }

      const cells: ResourceCell[] = [];
      const steps = [];
      for (const snapshot of snapshots) {
        for (const resource of manifest.contracts) {
          const address = getCreate2Address({
            from: resource.deployment.factory,
            salt: resource.deployment.salt,
            bytecodeHash: keccak256(resource.deployment.initCode),
          });
          const observed = await observeRuntimeCode(configuration.observer, {
            chainId: snapshot.chainId,
            address,
            snapshot,
          });
          const reviewedConfiguration = resource.configuration.map(
            ({ id, readData, expectedResult }) => ({
              id,
              readData,
              expectedResult,
            }),
          );
          if (observed.kind === "unreadable") {
            cells.push({
              resourceId: resource.id,
              chainId: snapshot.chainId,
              address,
              expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
              configuration: reviewedConfiguration,
              status: { kind: "unreadable", reason: observed.reason, configurationId: null },
            });
            continue;
          }
          if (observed.code === "0x") {
            cells.push({
              resourceId: resource.id,
              chainId: snapshot.chainId,
              address,
              expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
              configuration: reviewedConfiguration,
              status: { kind: "missing" },
            });
            steps.push({
              id: `${resource.id}:deploy`,
              resourceId: resource.id,
              chainId: snapshot.chainId,
              kind: "deploy" as const,
              configurationId: null,
              drift: "missing" as const,
              call: {
                target: resource.deployment.factory,
                data: encodeFunctionData({
                  abi: CREATE2_FACTORY_ABI,
                  functionName: "deploy",
                  args: [resource.deployment.salt, resource.deployment.initCode],
                }),
                value: BigInt(resource.deployment.value),
              },
              postconditions: [
                {
                  kind: "runtime-code-hash" as const,
                  address,
                  expectedHash: resource.expectedRuntimeCodeHash,
                },
              ],
            });
            continue;
          }
          const observedRuntimeCodeHash = keccak256(observed.code);
          if (observedRuntimeCodeHash === resource.expectedRuntimeCodeHash) {
            const configurationResults = [];
            let unreadable: {
              reason: "configuration-read-failed" | "configuration-invalid-response";
              id: string;
            } | null = null;
            const mismatches = [];
            for (const rule of resource.configuration) {
              const result = await observeCall(configuration.observer, {
                chainId: snapshot.chainId,
                target: address,
                data: rule.readData,
                snapshot,
              });
              if (result.kind === "unreadable") {
                unreadable = {
                  reason:
                    result.reason === "read-failed"
                      ? "configuration-read-failed"
                      : "configuration-invalid-response",
                  id: rule.id,
                };
                break;
              }
              configurationResults.push({ id: rule.id, result: result.result });
              if (result.result !== rule.expectedResult) {
                mismatches.push({
                  id: rule.id,
                  expectedResult: rule.expectedResult,
                  observedResult: result.result,
                });
              }
            }
            if (unreadable) {
              cells.push({
                resourceId: resource.id,
                chainId: snapshot.chainId,
                address,
                expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
                configuration: reviewedConfiguration,
                status: {
                  kind: "unreadable",
                  reason: unreadable.reason,
                  configurationId: unreadable.id,
                },
              });
            } else if (mismatches.length > 0) {
              cells.push({
                resourceId: resource.id,
                chainId: snapshot.chainId,
                address,
                expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
                configuration: reviewedConfiguration,
                status: { kind: "configuration-drift", observedRuntimeCodeHash, mismatches },
              });
              for (const mismatch of mismatches) {
                const rule = resource.configuration.find(
                  (candidate) => candidate.id === mismatch.id,
                );
                if (!rule) throw new Error("configuration disappeared");
                steps.push({
                  id: `${resource.id}:configure:${rule.id}`,
                  resourceId: resource.id,
                  chainId: snapshot.chainId,
                  kind: "configure" as const,
                  configurationId: rule.id,
                  drift: "configuration-drift" as const,
                  call: { target: address, data: rule.writeData, value: BigInt(rule.value) },
                  postconditions: [
                    {
                      kind: "static-call" as const,
                      target: address,
                      data: rule.readData,
                      expectedResult: rule.expectedResult,
                    },
                  ],
                });
              }
            } else {
              cells.push({
                resourceId: resource.id,
                chainId: snapshot.chainId,
                address,
                expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
                configuration: reviewedConfiguration,
                status: { kind: "converged", observedRuntimeCodeHash, configurationResults },
              });
            }
          } else {
            cells.push({
              resourceId: resource.id,
              chainId: snapshot.chainId,
              address,
              expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
              configuration: reviewedConfiguration,
              status: {
                kind: "bytecode-drift",
                observedRuntimeCodeHash,
              },
            });
          }
        }
      }

      return reviewPlan({
        manifestHash: manifest.manifestHash,
        snapshots,
        cells,
        steps,
      });
    },
  };
}

function parseChains(value: readonly number[]): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MoesiPlanningError("invalid_chains", null, "at least one chain is required");
  }
  const seen = new Set<number>();
  const chains = value.map((chainId) => {
    if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new MoesiPlanningError("invalid_chains", null, "chain id is invalid");
    }
    if (seen.has(chainId)) {
      throw new MoesiPlanningError("duplicate_chain", chainId, `duplicate chain ${chainId}`);
    }
    seen.add(chainId);
    return chainId;
  });
  return chains.sort((left, right) => left - right);
}

export async function captureChainSnapshot(
  observer: MoesiObservationAdapter,
  chainId: number,
): Promise<ChainSnapshot> {
  let value: unknown;
  try {
    value = await observer.captureSnapshot(chainId);
  } catch {
    throw new MoesiPlanningError(
      "snapshot_unreadable",
      chainId,
      `snapshot is unreadable for chain ${chainId}`,
    );
  }
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not a record");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("not a plain record");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== "blockNumber" && key !== "blockHash")) {
      throw new Error("unknown field");
    }
    if (typeof record.blockNumber !== "bigint" || record.blockNumber < 0n) {
      throw new Error("invalid block number");
    }
    if (typeof record.blockHash !== "string" || !SNAPSHOT_HASH_PATTERN.test(record.blockHash)) {
      throw new Error("invalid block hash");
    }
    return {
      chainId,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash.toLowerCase() as Hex,
    };
  } catch {
    throw new MoesiPlanningError("invalid_snapshot", chainId, "snapshot is invalid");
  }
}

export type RuntimeCodeObservation =
  | { readonly kind: "readable"; readonly code: Hex }
  | { readonly kind: "unreadable"; readonly reason: "read-failed" | "invalid-response" };

export async function observeRuntimeCode(
  observer: MoesiObservationAdapter,
  request: CodeReadRequest,
): Promise<RuntimeCodeObservation> {
  let value: unknown;
  try {
    value = await observer.readCode(request);
  } catch {
    return { kind: "unreadable", reason: "read-failed" };
  }
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    return { kind: "unreadable", reason: "invalid-response" };
  }
  return { kind: "readable", code: value.toLowerCase() as Hex };
}

export type CallObservation =
  | { readonly kind: "readable"; readonly result: Hex }
  | { readonly kind: "unreadable"; readonly reason: "read-failed" | "invalid-response" };

export async function observeCall(
  observer: MoesiObservationAdapter,
  request: CallReadRequest,
): Promise<CallObservation> {
  let value: unknown;
  try {
    value = await observer.readCall(request);
  } catch {
    return { kind: "unreadable", reason: "read-failed" };
  }
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    return { kind: "unreadable", reason: "invalid-response" };
  }
  return { kind: "readable", result: value.toLowerCase() as Hex };
}
