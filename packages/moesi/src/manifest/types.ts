import type { Address, Hex } from "viem";

export const MOESI_MANIFEST_VERSION = "moesi.manifest/v2" as const;

export interface Create2FactoryDeployment {
  readonly kind: "create2-factory-v1";
  readonly salt: Hex;
  readonly initCode: Hex;
  /** Canonical decimal uint256 string so the manifest remains JSON-safe. */
  readonly value: string;
  /** Resource IDs whose expected runtime hashes must be exact before deployment. */
  readonly requiresRuntime: readonly string[];
}

/**
 * One sender-protected CreateX CREATE2 deployment. The owning managed resource
 * must declare an `owner-eoa` sender; that address is part of both its raw salt
 * and deterministic target. Other CreateX guard branches are not supported by
 * this manifest version.
 */
export interface CreateXCreate2Deployment {
  readonly kind: "createx-create2-v1";
  /** Canonical lowercase 11-byte suffix used to form the CreateX raw salt. */
  readonly entropy: Hex;
  readonly initCode: Hex;
  /** Canonical decimal uint256 string so the manifest remains JSON-safe. */
  readonly value: string;
  /** Resource IDs whose expected runtime hashes must be exact before deployment. */
  readonly requiresRuntime: readonly string[];
}

/** Closed set of deployment strategies supported by this manifest version. */
export type ManagedDeployment = Create2FactoryDeployment | CreateXCreate2Deployment;

/**
 * Optional sender requirement for one contract's steps. `owner-eoa` requires an
 * exact externally-owned account; `smart-account` requires a logical smart
 * account that only an account-abstraction execution provider can satisfy.
 * Absent means the contract's steps are sender-independent (true for ordinary
 * CREATE2 factory deployments and permissionless configuration writes).
 */
export type ManifestSender =
  | { readonly kind: "owner-eoa"; readonly address: Address }
  | { readonly kind: "smart-account"; readonly accountId: string };

/**
 * Optional enforcement requirement for one contract's steps. When present, all
 * three facts are explicit. `required-onchain`/`required` demand an execution
 * provider with onchain enforcement; the direct viem provider blocks them.
 */
export interface ManifestEnforcement {
  readonly callScope: "required-onchain" | "interactive-review-sufficient";
  readonly expiry: "required" | "optional";
  readonly operationLimit: "required" | "optional";
}

export interface ConfigurationRule {
  readonly id: string;
  readonly readData: Hex;
  readonly expectedResult: Hex;
  readonly writeData: Hex;
  /** Canonical decimal uint256 string so the manifest remains JSON-safe. */
  readonly value: string;
}

/** One exact, read-only semantic assertion against a contract. */
export interface ReadOnlyCallCheck {
  readonly id: string;
  readonly caller: Address;
  readonly readData: Hex;
  readonly expectedResult: Hex;
}

/** One exact, read-only storage-word assertion against a contract. */
export interface StorageWordCheck {
  readonly id: string;
  readonly slot: Hex;
  readonly expectedWord: Hex;
}

interface ManagedContractResourceBase {
  readonly kind: "managed";
  readonly id: string;
  readonly expectedRuntimeCodeHash: Hex;
  readonly configuration: readonly ConfigurationRule[];
  readonly checks: readonly ReadOnlyCallCheck[];
  readonly storageChecks: readonly StorageWordCheck[];
  readonly enforcement?: ManifestEnforcement;
}

export interface Create2FactoryManagedContractResource extends ManagedContractResourceBase {
  readonly deployment: Create2FactoryDeployment;
  readonly sender?: ManifestSender;
}

export interface CreateXCreate2ManagedContractResource extends ManagedContractResourceBase {
  readonly deployment: CreateXCreate2Deployment;
  readonly sender: Extract<ManifestSender, { readonly kind: "owner-eoa" }>;
}

/** Closed managed resource set with strategy-specific sender requirements. */
export type ManagedContractResource =
  | Create2FactoryManagedContractResource
  | CreateXCreate2ManagedContractResource;

/** Infrastructure Moesi observes and verifies but never deploys or configures. */
export interface ExternalContractResource {
  readonly kind: "external";
  readonly id: string;
  readonly address: Address;
  readonly expectedRuntimeCodeHash: Hex;
  readonly checks: readonly ReadOnlyCallCheck[];
  readonly storageChecks: readonly StorageWordCheck[];
}

export type ContractResource = ManagedContractResource | ExternalContractResource;

export interface MoesiManifest {
  readonly version: "moesi.manifest/v2";
  readonly contracts: readonly ContractResource[];
}
