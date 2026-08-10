import type { Address, Hex } from "viem";

export const MOESI_MANIFEST_VERSION = "moesi.manifest/v1" as const;

export interface Create2FactoryDeployment {
  readonly kind: "create2-factory-v1";
  readonly salt: Hex;
  readonly initCode: Hex;
  /** Canonical decimal uint256 string so the manifest remains JSON-safe. */
  readonly value: string;
}

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

export interface ManagedContractResource {
  readonly kind: "managed";
  readonly id: string;
  readonly deployment: Create2FactoryDeployment;
  readonly expectedRuntimeCodeHash: Hex;
  readonly configuration: readonly ConfigurationRule[];
  readonly sender?: ManifestSender;
  readonly enforcement?: ManifestEnforcement;
}

/** One exact read-only call assertion against an external contract. */
export interface ExternalContractCheck {
  readonly id: string;
  readonly caller: Address;
  readonly readData: Hex;
  readonly expectedResult: Hex;
}

/** One exact read-only storage-word assertion against an external contract. */
export interface ExternalStorageCheck {
  readonly id: string;
  readonly slot: Hex;
  readonly expectedWord: Hex;
}

/** Infrastructure Moesi observes and verifies but never deploys or configures. */
export interface ExternalContractResource {
  readonly kind: "external";
  readonly id: string;
  readonly address: Address;
  readonly expectedRuntimeCodeHash: Hex;
  readonly checks: readonly ExternalContractCheck[];
  readonly storageChecks: readonly ExternalStorageCheck[];
}

export type ContractResource = ManagedContractResource | ExternalContractResource;

export interface MoesiManifest {
  readonly version: "moesi.manifest/v1";
  readonly contracts: readonly ContractResource[];
}
