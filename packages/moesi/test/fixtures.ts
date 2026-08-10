import type { Hex } from "viem";
import { parseManifest } from "../src/manifest/parse.js";
import type {
  ConfigurationRule,
  ManagedContractResource,
  ManifestEnforcement,
  ManifestSender,
  MoesiManifest,
} from "../src/manifest/types.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
  compileConfigurationCall,
  compileConfigurationCaller,
  compileDeploymentCall,
  compileResourceEnforcement,
  compileResourceSender,
  deriveResourceAddress,
} from "../src/planning/resource.js";
import type { PlanDraft } from "../src/planning/types.js";

export const testHash = (byte: string): Hex =>
  `0x${(byte.length === 1 ? byte.repeat(2) : byte).repeat(32)}` as Hex;
export const testAddress = (byte: string): `0x${string}` => `0x${byte.repeat(40)}`;

export type ManagedTestManifest = Omit<MoesiManifest, "contracts"> & {
  readonly contracts: readonly ManagedContractResource[];
};

export function testManifest(
  input: {
    readonly id?: string;
    readonly salt?: Hex;
    readonly initCode?: Hex;
    readonly deploymentValue?: string;
    readonly runtimeHash?: Hex;
    readonly configuration?: readonly ConfigurationRule[];
    readonly sender?: ManifestSender;
    readonly enforcement?: ManifestEnforcement;
  } = {},
): ManagedTestManifest {
  const resource: ManagedContractResource = {
    kind: "managed",
    id: input.id ?? "counter",
    deployment: {
      kind: "create2-factory-v1",
      salt: input.salt ?? testHash("b"),
      initCode: input.initCode ?? "0x60006000",
      value: input.deploymentValue ?? "0",
    },
    expectedRuntimeCodeHash: input.runtimeHash ?? testHash("d"),
    configuration: input.configuration ?? [],
    ...(input.sender === undefined ? {} : { sender: input.sender }),
    ...(input.enforcement === undefined ? {} : { enforcement: input.enforcement }),
  };
  return { version: "moesi.manifest/v1", contracts: [resource] };
}

export function missingPlanDraft(
  input: {
    readonly manifest?: MoesiManifest;
    readonly chainIds?: readonly number[];
    readonly firstBlockNumber?: bigint;
  } = {},
): PlanDraft {
  const parsed = parseManifest(input.manifest ?? testManifest());
  const manifest: MoesiManifest = { version: parsed.version, contracts: parsed.contracts };
  const chainIds = input.chainIds ?? [1];
  const firstBlockNumber = input.firstBlockNumber ?? 1n;
  const snapshots = chainIds.map((chainId, index) => ({
    chainId,
    blockNumber: (firstBlockNumber + BigInt(index)).toString(10),
    blockHash: testHash((index + 1).toString(16)),
  }));
  const cells = snapshots.flatMap(({ chainId }) =>
    parsed.contracts.map((resource) => ({
      resourceId: resource.id,
      chainId,
      address: deriveResourceAddress(resource),
      expectedRuntimeCodeHash: resource.expectedRuntimeCodeHash,
      configuration:
        resource.kind === "managed"
          ? resource.configuration.map(({ id, readData, expectedResult }) => ({
              id,
              readData,
              caller:
                resource.sender?.kind === "owner-eoa" ? resource.sender.address : testAddress("0"),
              expectedResult,
            }))
          : [],
      status: { kind: "missing" as const },
    })),
  );
  const hasManagedResources = parsed.contracts.some((resource) => resource.kind === "managed");
  const capabilities = hasManagedResources
    ? snapshots.map(({ chainId }) => ({
        kind: "create2-factory-v1" as const,
        chainId,
        address: CREATE2_FACTORY_V1_ADDRESS,
        expectedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
        status: {
          kind: "available" as const,
          observedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
        },
      }))
    : [];
  const steps = snapshots.flatMap(({ chainId }) => {
    const managedResources = parsed.contracts.filter(
      (resource): resource is ManagedContractResource => resource.kind === "managed",
    );
    const deployments = managedResources.map((resource) => {
      const address = deriveResourceAddress(resource);
      return {
        id: `${resource.id}:deploy`,
        resourceId: resource.id,
        chainId,
        kind: "deploy" as const,
        configurationId: null,
        drift: "missing" as const,
        call: compileDeploymentCall(resource),
        postconditions: [
          {
            kind: "runtime-code-hash" as const,
            address,
            expectedHash: resource.expectedRuntimeCodeHash,
          },
        ],
        sender: compileResourceSender(resource.sender),
        enforcement: compileResourceEnforcement(resource),
      };
    });
    const configurations = managedResources.flatMap((resource) => {
      const address = deriveResourceAddress(resource);
      const caller = compileConfigurationCaller(resource);
      return resource.configuration.map((rule) => ({
        id: `${resource.id}:configure:${rule.id}`,
        resourceId: resource.id,
        chainId,
        kind: "configure" as const,
        configurationId: rule.id,
        drift: "missing" as const,
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
        sender: compileResourceSender(resource.sender),
        enforcement: compileResourceEnforcement(resource),
      }));
    });
    return [...deployments, ...configurations];
  });
  return { manifest, snapshots, capabilities, cells, steps };
}
