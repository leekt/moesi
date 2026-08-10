import { keccak256 } from "viem";
import { MoesiPlanningError } from "../errors.js";
import { mapArrayElements, snapshotArray } from "../internal.js";
import type { ParsedManifest } from "../manifest/parse.js";
import {
  captureChainSnapshot,
  observeCall,
  observeRuntimeCode,
  observeStorage,
} from "../observation/observe.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "../observation/types.js";
import { deriveActionableMissingManagedResourceIds } from "./prerequisites.js";
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
import type {
  DeploymentCapability,
  DeploymentStep,
  ResourceCell,
  ReviewedPlan,
  UnreadableResourceStatus,
} from "./types.js";
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
      const address = deriveResourceAddress(resource);
      const observed = await observeRuntimeCode(input.observer, {
        chainId: snapshot.chainId,
        address,
        snapshot,
      });
      const reviewedConfiguration =
        resource.kind === "managed"
          ? resource.configuration.map(({ id, readData, expectedResult }) => ({
              id,
              readData,
              caller: compileConfigurationCaller(resource),
              expectedResult,
            }))
          : [];
      const reviewedChecks = resource.checks.map(({ id, caller, readData, expectedResult }) => ({
        id,
        readData,
        caller,
        expectedResult,
      }));
      const reviewedStorageChecks = resource.storageChecks.map(({ id, slot, expectedWord }) => ({
        id,
        slot,
        expectedWord,
      }));
      const cellBase = {
        resourceId: resource.id,
        chainId: snapshot.chainId,
        address,
        expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
        configuration: reviewedConfiguration,
        checks: reviewedChecks,
        storageChecks: reviewedStorageChecks,
      } as const;
      if (observed.kind === "unreadable") {
        cells.push({
          ...cellBase,
          status: {
            kind: "unreadable",
            source: "runtime-code",
            id: null,
            reason: observed.reason,
          },
        });
        continue;
      }
      if (observed.code === "0x") {
        cells.push({
          ...cellBase,
          status: { kind: "missing" },
        });
        continue;
      }
      const observedRuntimeCodeHash = keccak256(observed.code);
      if (observedRuntimeCodeHash === resource.expectedRuntimeCodeHash) {
        const configurationResults = [];
        const callResults = [];
        const storageResults = [];
        let unreadable: Exclude<UnreadableResourceStatus, { source: "runtime-code" }> | null = null;
        const configurationMismatches = [];
        const callMismatches = [];
        const storageMismatches = [];
        for (const check of reviewedStorageChecks) {
          const result = await observeStorage(input.observer, {
            chainId: snapshot.chainId,
            address,
            slot: check.slot,
            snapshot,
          });
          if (result.kind === "unreadable") {
            unreadable = {
              kind: "unreadable",
              source: "storage-check",
              id: check.id,
              reason: result.reason,
              observedRuntimeCodeHash,
            };
            break;
          }
          storageResults.push({ id: check.id, word: result.word });
          if (result.word !== check.expectedWord) {
            storageMismatches.push({
              id: check.id,
              expectedWord: check.expectedWord,
              observedWord: result.word,
            });
          }
        }
        if (unreadable === null) {
          for (const check of reviewedChecks) {
            const result = await observeCall(input.observer, {
              chainId: snapshot.chainId,
              target: address,
              data: check.readData,
              caller: check.caller,
              snapshot,
            });
            if (result.kind === "unreadable") {
              unreadable = {
                kind: "unreadable",
                source: "call-check",
                id: check.id,
                reason: result.reason,
                observedRuntimeCodeHash,
              };
              break;
            }
            callResults.push({ id: check.id, result: result.result });
            if (result.result !== check.expectedResult) {
              callMismatches.push({
                id: check.id,
                expectedResult: check.expectedResult,
                observedResult: result.result,
              });
            }
          }
        }
        if (unreadable === null) {
          for (const configuration of reviewedConfiguration) {
            const result = await observeCall(input.observer, {
              chainId: snapshot.chainId,
              target: address,
              data: configuration.readData,
              caller: configuration.caller,
              snapshot,
            });
            if (result.kind === "unreadable") {
              unreadable = {
                kind: "unreadable",
                source: "configuration",
                id: configuration.id,
                reason: result.reason,
                observedRuntimeCodeHash,
              };
              break;
            }
            configurationResults.push({ id: configuration.id, result: result.result });
            if (result.result !== configuration.expectedResult) {
              configurationMismatches.push({
                id: configuration.id,
                expectedResult: configuration.expectedResult,
                observedResult: result.result,
              });
            }
          }
        }
        if (unreadable) {
          cells.push({
            ...cellBase,
            status: unreadable,
          });
        } else if (
          configurationMismatches.length > 0 ||
          callMismatches.length > 0 ||
          storageMismatches.length > 0
        ) {
          cells.push({
            ...cellBase,
            status: {
              kind: "drift",
              observedRuntimeCodeHash,
              configurationMismatches,
              callMismatches,
              storageMismatches,
            },
          });
          if (resource.kind === "managed") {
            const sender = compileResourceSender(resource.sender);
            const enforcement = compileResourceEnforcement(resource);
            const caller = compileConfigurationCaller(resource);
            for (const mismatch of configurationMismatches) {
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
          }
        } else {
          cells.push({
            ...cellBase,
            status: {
              kind: "converged",
              observedRuntimeCodeHash,
              configurationResults,
              callResults,
              storageResults,
            },
          });
        }
      } else {
        cells.push({
          ...cellBase,
          status: {
            kind: "bytecode-drift",
            observedRuntimeCodeHash,
          },
        });
      }
    }

    const chainCells = cells.filter(({ chainId }) => chainId === snapshot.chainId);
    const managedResourceIds = new Set(
      input.manifest.contracts
        .filter((resource) => resource.kind === "managed")
        .map(({ id }) => id),
    );
    const missingManagedCells = chainCells.filter(
      ({ resourceId, status }) => status.kind === "missing" && managedResourceIds.has(resourceId),
    );
    if (missingManagedCells.length === 0) continue;

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
    const capability: DeploymentCapability = {
      kind: "create2-factory-v1",
      chainId: snapshot.chainId,
      address: CREATE2_FACTORY_V1_ADDRESS,
      expectedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
      status: capabilityStatus,
    };
    capabilities.push(capability);
    const actionableResourceIds = deriveActionableMissingManagedResourceIds({
      contracts: input.manifest.contracts,
      cells: chainCells,
      capability,
    });
    const resourcesById = new Map(
      input.manifest.contracts.map((resource) => [resource.id, resource] as const),
    );
    const deploymentSteps: DeploymentStep[] = [];
    const configurationSteps: DeploymentStep[] = [];
    for (const resourceId of actionableResourceIds) {
      const resource = resourcesById.get(resourceId);
      if (resource?.kind !== "managed") throw new Error("managed deployment order disappeared");
      const sender = compileResourceSender(resource.sender);
      const enforcement = compileResourceEnforcement(resource);
      const caller = compileConfigurationCaller(resource);
      const address = deriveResourceAddress(resource);
      deploymentSteps.push({
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
        configurationSteps.push({
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
    steps.push(...deploymentSteps, ...configurationSteps);
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
