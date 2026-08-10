import { keccak256 } from "viem";
import { MoesiPlanningError } from "../errors.js";
import { mapArrayElements, snapshotArray } from "../internal.js";
import type { ParsedManifest } from "../manifest/parse.js";
import { captureChainSnapshot, observeCall, observeRuntimeCode } from "../observation/observe.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "../observation/types.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
  compileConfigurationCall,
  compileConfigurationCaller,
  compileDeploymentCall,
  compileResourceEnforcement,
  compileResourceSender,
  deriveResourceAddress,
} from "./resource.js";
import { reviewPlan } from "./reviewed-plan.js";
import type { DeploymentCapability, DeploymentStep, ResourceCell, ReviewedPlan } from "./types.js";
import { MAX_PLAN_CHAINS } from "./types.js";

export interface CreatePlanInput {
  readonly manifest: ParsedManifest;
  readonly chains: readonly number[];
  readonly observer: MoesiObservationAdapter;
}

export async function createPlan(input: CreatePlanInput): Promise<ReviewedPlan> {
  const chains = parseChains(input.chains);
  const snapshots: ChainSnapshot[] = [];
  for (const chainId of chains) {
    snapshots.push(await captureChainSnapshot(input.observer, chainId));
  }

  const cells: ResourceCell[] = [];
  const capabilities: DeploymentCapability[] = [];
  const steps: DeploymentStep[] = [];
  for (const snapshot of snapshots) {
    for (const resource of input.manifest.contracts) {
      const sender = compileResourceSender(resource.sender);
      const enforcement = compileResourceEnforcement(resource);
      const caller = compileConfigurationCaller(resource);
      const address = deriveResourceAddress(resource);
      const observed = await observeRuntimeCode(input.observer, {
        chainId: snapshot.chainId,
        address,
        snapshot,
      });
      const reviewedConfiguration = resource.configuration.map(
        ({ id, readData, expectedResult }) => ({
          id,
          readData,
          caller,
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
          const result = await observeCall(input.observer, {
            chainId: snapshot.chainId,
            target: address,
            data: rule.readData,
            caller,
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
            const rule = resource.configuration.find((candidate) => candidate.id === mismatch.id);
            if (!rule) throw new Error("configuration disappeared");
            steps.push({
              id: `${resource.id}:configure:${rule.id}`,
              resourceId: resource.id,
              chainId: snapshot.chainId,
              kind: "configure" as const,
              configurationId: rule.id,
              drift: "configuration-drift" as const,
              call: compileConfigurationCall(address, rule),
              postconditions: [
                {
                  kind: "static-call" as const,
                  target: address,
                  data: rule.readData,
                  caller,
                  expectedResult: rule.expectedResult,
                },
              ],
              sender,
              enforcement,
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

    const chainCells = cells.filter(({ chainId }) => chainId === snapshot.chainId);
    const missingCells = chainCells.filter(({ status }) => status.kind === "missing");
    if (missingCells.length === 0) continue;

    const observed = await observeRuntimeCode(input.observer, {
      chainId: snapshot.chainId,
      address: CREATE2_FACTORY_V1_ADDRESS,
      snapshot,
    });
    let capabilityStatus: DeploymentCapability["status"];
    if (observed.kind === "unreadable") {
      capabilityStatus = { kind: "unreadable", reason: observed.reason };
    } else if (observed.code === "0x") {
      capabilityStatus = { kind: "missing" };
    } else {
      const observedRuntimeCodeHash = keccak256(observed.code);
      capabilityStatus =
        observedRuntimeCodeHash === CREATE2_FACTORY_V1_RUNTIME_CODE_HASH
          ? { kind: "available", observedRuntimeCodeHash }
          : { kind: "bytecode-drift", observedRuntimeCodeHash };
    }
    capabilities.push({
      kind: "create2-factory-v1",
      chainId: snapshot.chainId,
      address: CREATE2_FACTORY_V1_ADDRESS,
      expectedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
      status: capabilityStatus,
    });
    if (capabilityStatus.kind !== "available") continue;

    const missingResourceIds = new Set(missingCells.map(({ resourceId }) => resourceId));
    for (const resource of input.manifest.contracts) {
      if (!missingResourceIds.has(resource.id)) continue;
      const sender = compileResourceSender(resource.sender);
      const enforcement = compileResourceEnforcement(resource);
      const caller = compileConfigurationCaller(resource);
      const address = deriveResourceAddress(resource);
      steps.push({
        id: `${resource.id}:deploy`,
        resourceId: resource.id,
        chainId: snapshot.chainId,
        kind: "deploy",
        configurationId: null,
        drift: "missing",
        call: compileDeploymentCall(resource),
        postconditions: [
          {
            kind: "runtime-code-hash",
            address,
            expectedHash: resource.expectedRuntimeCodeHash,
          },
        ],
        sender,
        enforcement,
      });
      for (const rule of resource.configuration) {
        steps.push({
          id: `${resource.id}:configure:${rule.id}`,
          resourceId: resource.id,
          chainId: snapshot.chainId,
          kind: "configure",
          configurationId: rule.id,
          drift: "missing",
          call: compileConfigurationCall(address, rule),
          postconditions: [
            {
              kind: "static-call",
              target: address,
              data: rule.readData,
              caller,
              expectedResult: rule.expectedResult,
            },
          ],
          sender,
          enforcement,
        });
      }
    }
  }

  return reviewPlan({
    manifest: {
      version: input.manifest.version,
      contracts: input.manifest.contracts,
    },
    snapshots,
    capabilities,
    cells,
    steps,
  });
}

function parseChains(value: readonly number[]): number[] {
  const entries = snapshotArray(value);
  if (entries === null || entries.length === 0) {
    throw new MoesiPlanningError("invalid_chains", null, "at least one chain is required");
  }
  if (entries.length > MAX_PLAN_CHAINS) {
    throw new MoesiPlanningError(
      "invalid_chains",
      null,
      `at most ${MAX_PLAN_CHAINS} chains may be planned at once`,
    );
  }
  const seen = new Set<number>();
  const chains = mapArrayElements(entries, (chainId) => {
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
