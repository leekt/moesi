import { keccak256 } from "cetane/utils";
import { MoesiPlanningError } from "../errors.js";
import { mapArrayElements, snapshotArray } from "../internal.js";
import type { ParsedManifest } from "../manifest/parse.js";
import { requiredConfigurationPeers } from "../manifest/peers.js";
import { compileResourceChecks } from "../manifest/semantic.js";
import { resourceChainBinding } from "../manifest/target.js";
import { observeAccountModules } from "../modules/observe.js";
import { compileModuleRemovals } from "../modules/removal.js";
import {
  isCallCheckSatisfied,
  observeReviewedCallCheck,
  observeReviewedStorageCheck,
} from "../observation/checks.js";
import { captureChainSnapshot, observeCall, observeRuntimeCode } from "../observation/observe.js";
import { readConcurrently } from "../observation/parallel.js";
import { configurationReadiness, observeConfigurationPeers } from "../observation/peers.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "../observation/types.js";
import { compileConfigurationSteps } from "./configuration.js";
import { deriveActionableMissingManagedResourceIds } from "./prerequisites.js";
import {
  compileConfigurationCaller,
  compileDeploymentCall,
  compileResourceEnforcement,
  compileResourceSender,
  deploymentCapabilitySpec,
  deriveResourceAddress,
} from "./resource.js";
import { reviewPlan } from "./reviewed-plan.js";
import type {
  DeploymentCapability,
  DeploymentStep,
  ResourceCell,
  ResourceCellBase,
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
  for (const resource of input.manifest.contracts) {
    const bound = resourceChainBinding(resource);
    const foreign = chains.find((chainId) => bound !== null && chainId !== bound);
    if (foreign !== undefined) {
      throw new MoesiPlanningError(
        "chain_bound_resource",
        foreign,
        `resource ${resource.id} is bound to chain ${bound} and cannot be planned on chain ${foreign}`,
      );
    }
  }
  const snapshots: ChainSnapshot[] = [];
  const peers = await observeConfigurationPeers(
    input.observer,
    requiredConfigurationPeers(input.manifest),
  );
  const cells: ResourceCell[] = [];
  const capabilities: DeploymentCapability[] = [];
  const steps: DeploymentStep[] = [];
  for (const chainId of chains) {
    const snapshot = await captureChainSnapshot(input.observer, chainId);
    snapshots.push(snapshot);
    const chainCells = await readConcurrently(
      input.manifest.contracts,
      async (resource): Promise<ResourceCell> => {
        const address = deriveResourceAddress(resource);
        const observed = await observeRuntimeCode(input.observer, {
          chainId: snapshot.chainId,
          address,
          snapshot,
        });
        const reviewedConfiguration =
          resource.kind === "managed"
            ? resource.configuration.map(({ id, readData, expectedResult, after }) => ({
                id,
                readData,
                caller: compileConfigurationCaller(resource),
                expectedResult,
                ...(after === undefined ? {} : { readiness: configurationReadiness(after, peers) }),
              }))
            : [];
        const { checks: reviewedChecks, storageChecks: reviewedStorageChecks } =
          compileResourceChecks(resource);
        let cellBase: ResourceCellBase = {
          resourceId: resource.id,
          chainId: snapshot.chainId,
          address,
          expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
          configuration: reviewedConfiguration,
          checks: reviewedChecks,
          storageChecks: reviewedStorageChecks,
        } as const;
        if (observed.kind === "unreadable") {
          return {
            ...cellBase,
            status: {
              kind: "unreadable",
              source: "runtime-code",
              id: null,
              reason: observed.reason,
              ...(observed.cause ? { cause: observed.cause } : {}),
            },
          };
        }
        if (observed.code === "0x") {
          return {
            ...cellBase,
            status: { kind: "missing" },
          };
        }
        const observedRuntimeCodeHash = keccak256(observed.code);
        if (observedRuntimeCodeHash === resource.expectedRuntimeCodeHash) {
          if (resource.accountModules) {
            const accountModules = await observeAccountModules(
              input.observer,
              address,
              snapshot,
              resource.accountModules,
            );
            cellBase = { ...cellBase, accountModules };
            if (accountModules.kind === "drifted")
              return {
                ...cellBase,
                status: { kind: "module-drift", observedRuntimeCodeHash },
              };
            if (accountModules.kind !== "satisfied")
              return {
                ...cellBase,
                status: {
                  kind: "unreadable",
                  source: "account-modules",
                  id: "account-modules",
                  observedRuntimeCodeHash,
                  reason:
                    accountModules.kind === "incomplete" ? "incomplete" : accountModules.reason,
                },
              };
          }

          const configurationResults = [];
          const callResults = [];
          const storageResults = [];
          let unreadable: Exclude<UnreadableResourceStatus, { source: "runtime-code" }> | null =
            null;
          const configurationMismatches = [];
          const callMismatches = [];
          const storageMismatches = [];
          const observedStorageChecks = await readConcurrently(
            reviewedStorageChecks,
            async (check) => ({
              check,
              result: await observeReviewedStorageCheck(input.observer, snapshot, address, check),
            }),
          );
          for (const { check, result } of observedStorageChecks) {
            if (result.kind === "unreadable") {
              unreadable = {
                kind: "unreadable",
                source: "storage-check",
                id: check.id,
                reason: result.reason,
                ...(result.cause ? { cause: result.cause } : {}),
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
            const observedChecks = await readConcurrently(reviewedChecks, async (check) => ({
              check,
              result: await observeReviewedCallCheck(input.observer, snapshot, check),
            }));
            for (const { check, result } of observedChecks) {
              if (result.kind === "unreadable") {
                unreadable = {
                  kind: "unreadable",
                  source: "call-check",
                  id: check.id,
                  reason: result.reason,
                  ...(result.cause ? { cause: result.cause } : {}),
                  observedRuntimeCodeHash,
                };
                break;
              }
              callResults.push({ id: check.id, result: result.result });
              if (!isCallCheckSatisfied(check, result.result)) {
                callMismatches.push({
                  id: check.id,
                  expectedResult: check.expectedResult,
                  observedResult: result.result,
                });
              }
            }
          }
          if (unreadable === null) {
            const observedConfiguration = await readConcurrently(
              reviewedConfiguration,
              async (configuration) => ({
                configuration,
                result: await observeCall(input.observer, {
                  chainId: snapshot.chainId,
                  target: address,
                  data: configuration.readData,
                  caller: configuration.caller,
                  snapshot,
                }),
              }),
            );
            for (const { configuration, result } of observedConfiguration) {
              if (result.kind === "unreadable") {
                unreadable = {
                  kind: "unreadable",
                  source: "configuration",
                  id: configuration.id,
                  reason: result.reason,
                  ...(result.cause ? { cause: result.cause } : {}),
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
            return {
              ...cellBase,
              status: unreadable,
            };
          } else if (
            configurationMismatches.length > 0 ||
            callMismatches.length > 0 ||
            storageMismatches.length > 0
          ) {
            return {
              ...cellBase,
              status: {
                kind: "drift",
                observedRuntimeCodeHash,
                configurationMismatches,
                callMismatches,
                storageMismatches,
              },
            };
          } else {
            return {
              ...cellBase,
              status: {
                kind: "converged",
                observedRuntimeCodeHash,
                configurationResults,
                callResults,
                storageResults,
              },
            };
          }
        } else {
          return {
            ...cellBase,
            status: {
              kind: "bytecode-drift",
              observedRuntimeCodeHash,
            },
          };
        }
      },
    );
    cells.push(...chainCells);
    // Reduce in manifest order so completion timing never changes executable call order.
    for (const [index, resource] of input.manifest.contracts.entries()) {
      const cell = chainCells[index]!;
      steps.push(...compileModuleRemovals(resource, cell));
      if (resource.kind === "managed" && cell.status.kind === "drift")
        steps.push(...compileConfigurationSteps(resource, cell));
    }

    const managedResourceIds = new Set(
      input.manifest.contracts
        .filter((resource) => resource.kind === "managed")
        .map(({ id }) => id),
    );
    const missingManagedCells = chainCells.filter(
      ({ resourceId, status }) => status.kind === "missing" && managedResourceIds.has(resourceId),
    );
    if (missingManagedCells.length === 0) continue;

    const resourcesById = new Map(
      input.manifest.contracts.map((resource) => [resource.id, resource] as const),
    );
    const missingCapabilitySpecs = new Map(
      missingManagedCells.map(({ resourceId }) => {
        const resource = resourcesById.get(resourceId);
        if (resource?.kind !== "managed") {
          throw new Error("missing managed deployment resource disappeared");
        }
        const spec = deploymentCapabilitySpec(resource.deployment);
        return [spec.kind, spec] as const;
      }),
    );
    const chainCapabilities: DeploymentCapability[] = [];
    for (const canonical of [...missingCapabilitySpecs.values()].sort((left, right) =>
      compareDeploymentCapabilityKinds(left.kind, right.kind),
    )) {
      const observed = await observeRuntimeCode(input.observer, {
        chainId: snapshot.chainId,
        address: canonical.address,
        snapshot,
      });
      let capabilityStatus: DeploymentCapability["status"];
      if (observed.kind === "unreadable") {
        capabilityStatus = {
          kind: "unreadable",
          reason: observed.reason,
          ...(observed.cause ? { cause: observed.cause } : {}),
        };
      } else if (observed.code === "0x") {
        capabilityStatus = { kind: "missing" };
      } else {
        const observedRuntimeCodeHash = keccak256(observed.code);
        capabilityStatus =
          observedRuntimeCodeHash === canonical.expectedRuntimeCodeHash
            ? { kind: "available", observedRuntimeCodeHash }
            : { kind: "bytecode-drift", observedRuntimeCodeHash };
      }
      const capability: DeploymentCapability = {
        kind: canonical.kind,
        chainId: snapshot.chainId,
        address: canonical.address,
        expectedRuntimeCodeHash: canonical.expectedRuntimeCodeHash,
        status: capabilityStatus,
      };
      chainCapabilities.push(capability);
      capabilities.push(capability);
    }
    const actionableResourceIds = deriveActionableMissingManagedResourceIds({
      contracts: input.manifest.contracts,
      cells: chainCells,
      capabilities: chainCapabilities,
    });
    const deploymentSteps: DeploymentStep[] = [];
    const configurationSteps: DeploymentStep[] = [];
    for (const resourceId of actionableResourceIds) {
      const resource = resourcesById.get(resourceId);
      if (resource?.kind !== "managed") throw new Error("managed deployment order disappeared");
      const sender = compileResourceSender(resource.sender);
      const enforcement = compileResourceEnforcement(resource);
      const address = deriveResourceAddress(resource);
      deploymentSteps.push({
        id: `${resource.id}:deploy`,
        resourceId: resource.id,
        chainId: snapshot.chainId,
        kind: "deploy",
        configurationIds: [],
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
      const cell = chainCells.find((cell) => cell.resourceId === resource.id)!;
      configurationSteps.push(...compileConfigurationSteps(resource, cell));
    }
    steps.push(...deploymentSteps, ...configurationSteps);
  }

  return reviewPlan({
    manifest: {
      version: input.manifest.version,
      contracts: input.manifest.contracts,
    },
    snapshots,
    peers,
    capabilities,
    cells,
    steps,
  });
}

function compareDeploymentCapabilityKinds(
  left: DeploymentCapability["kind"],
  right: DeploymentCapability["kind"],
): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
