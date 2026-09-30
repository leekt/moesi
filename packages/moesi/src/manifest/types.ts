import type { Address, Hex } from "viem";

export const MOESI_MANIFEST_VERSION = "moesi.manifest/v6" as const;

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
 * must declare an exact sender; that address is part of both its raw salt
 * and deterministic target.
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

/**
 * One unguarded CreateX CREATE2 deployment. The raw salt is
 * `zero-address(20) || 0x00 || entropy(11)`, which CreateX classifies as
 * (ZeroAddress, no redeploy protection) and hashes as
 * `keccak256(abi.encode(rawSalt))`. No sender is bound: anyone may execute the
 * deployment and the runtime-code-hash postcondition at the derived address
 * carries convergence.
 */
export interface CreateXCreate2UnguardedDeployment {
  readonly kind: "createx-create2-unguarded-v1";
  /** Canonical lowercase 11-byte suffix used to form the CreateX raw salt. */
  readonly entropy: Hex;
  readonly initCode: Hex;
  /** Canonical decimal uint256 string so the manifest remains JSON-safe. */
  readonly value: string;
  /** Resource IDs whose expected runtime hashes must be exact before deployment. */
  readonly requiresRuntime: readonly string[];
}

/**
 * One unguarded CreateX CREATE3 deployment: the same unguarded raw salt as
 * `createx-create2-unguarded-v1`, deployed through CreateX's CREATE3 proxy so
 * the target address is independent of `initCode`.
 */
export interface CreateXCreate3UnguardedDeployment {
  readonly kind: "createx-create3-unguarded-v1";
  /** Canonical lowercase 11-byte suffix used to form the CreateX raw salt. */
  readonly entropy: Hex;
  readonly initCode: Hex;
  /** Canonical decimal uint256 string so the manifest remains JSON-safe. */
  readonly value: string;
  /** Resource IDs whose expected runtime hashes must be exact before deployment. */
  readonly requiresRuntime: readonly string[];
}

/**
 * One crosschain-protected CreateX deployment. The raw salt is
 * `zero-address(20) || 0x01 || entropy(11)`, which CreateX hashes as
 * `keccak256(abi.encode(block.chainid, rawSalt))`. The target address depends
 * on the chain, so the deployment binds exactly one `chainId` and planning
 * rejects every other chain. No sender is bound.
 */
export interface CreateXCreate2CrosschainDeployment {
  readonly kind: "createx-create2-crosschain-v1";
  /** The only chain whose CreateX derives this resource's address. */
  readonly chainId: number;
  /** Canonical lowercase 11-byte suffix used to form the CreateX raw salt. */
  readonly entropy: Hex;
  readonly initCode: Hex;
  /** Canonical decimal uint256 string so the manifest remains JSON-safe. */
  readonly value: string;
  /** Resource IDs whose expected runtime hashes must be exact before deployment. */
  readonly requiresRuntime: readonly string[];
}

/** Crosschain-protected CreateX CREATE3, independent of init code for address derivation. */
export interface CreateXCreate3CrosschainDeployment
  extends Omit<CreateXCreate2CrosschainDeployment, "kind"> {
  readonly kind: "createx-create3-crosschain-v1";
}

/**
 * One sender-and-crosschain-protected CreateX deployment. The raw salt is
 * `sender(20) || 0x01 || entropy(11)`, which CreateX hashes as
 * `keccak256(abi.encode(msg.sender, block.chainid, rawSalt))`. The owning
 * resource must declare an exact sender, and the deployment binds one `chainId`.
 */
export interface CreateXCreate2SenderCrosschainDeployment
  extends Omit<CreateXCreate2CrosschainDeployment, "kind"> {
  readonly kind: "createx-create2-sender-crosschain-v1";
}

/** Sender-and-crosschain-protected CreateX CREATE3. */
export interface CreateXCreate3SenderCrosschainDeployment
  extends Omit<CreateXCreate2CrosschainDeployment, "kind"> {
  readonly kind: "createx-create3-sender-crosschain-v1";
}

/** Closed set of deployment strategies supported by this manifest version. */
export type ManagedDeployment =
  | Create2FactoryDeployment
  | CreateXCreate2Deployment
  | CreateXCreate3Deployment
  | CreateXCreate2UnguardedDeployment
  | CreateXCreate3UnguardedDeployment
  | CreateXCreate2CrosschainDeployment
  | CreateXCreate3CrosschainDeployment
  | CreateXCreate2SenderCrosschainDeployment
  | CreateXCreate3SenderCrosschainDeployment;

/** Deployments whose target address is valid on exactly one chain. */
export type ChainBoundDeployment =
  | CreateXCreate2CrosschainDeployment
  | CreateXCreate3CrosschainDeployment
  | CreateXCreate2SenderCrosschainDeployment
  | CreateXCreate3SenderCrosschainDeployment;

/**
 * Optional sender requirement for one contract's steps. `owner-eoa` requires an
 * exact externally-owned account; `smart-account` binds a logical account ID
 * and concrete address that an account-abstraction execution provider must
 * both satisfy. Configuration reads use that concrete sender as their caller.
 * Absent means the contract's steps are sender-independent (true for ordinary
 * CREATE2 factory deployments and permissionless configuration writes).
 */
export type ManifestSender =
  | { readonly kind: "owner-eoa"; readonly address: Address }
  | { readonly kind: "smart-account"; readonly accountId: string; readonly address: Address };

/** Sender-protected CreateX CREATE3, independent of init code for address derivation. */
export interface CreateXCreate3Deployment extends Omit<CreateXCreate2Deployment, "kind"> {
  readonly kind: "createx-create3-v1";
}

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
  /** Adjacent rows with the same key merge only their drifted one-row ABI calls. */
  readonly batch?: ConfigurationBatch;
  /** Skip this row until these exact peer runtimes are available. */
  readonly after?: readonly ConfigurationPeer[];
}

export interface ConfigurationPeer {
  readonly chainId: number;
  readonly address: Address;
  readonly expectedRuntimeCodeHash: Hex;
}

export type ConfigurationBatchParameter =
  | `(${string})[]`
  | "address[]"
  | "bool[]"
  | "bytes[]"
  | "string[]"
  | `bytes${number}[]`
  | `uint${number}[]`
  | `int${number}[]`;

export interface ConfigurationBatch {
  readonly key: string;
  readonly parameters: readonly ConfigurationBatchParameter[];
  /** Maximum rows in one reviewed call, independent of provider operation packing. */
  readonly maxRows: number;
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

/** Read-only desired semantics; these declarations never authorize a repair. */
export type SemanticCheck =
  | {
      readonly kind: "ownable-owner";
      readonly id: string;
      readonly caller: Address;
      readonly expectedOwner: Address;
    }
  | {
      readonly kind: "access-control-role";
      readonly id: string;
      readonly caller: Address;
      readonly role: Hex;
      readonly account: Address;
      readonly expectedMember: boolean;
      readonly expectedAdminRole: Hex;
    }
  | {
      readonly kind: "erc1967-direct";
      readonly id: string;
      readonly expectedImplementation: Address;
      readonly expectedAdmin: Address;
    }
  | {
      readonly kind: "erc1967-beacon";
      readonly id: string;
      readonly caller: Address;
      readonly expectedBeacon: Address;
      readonly expectedImplementation: Address;
      readonly expectedAdmin: Address;
    };

interface ManagedContractResourceBase {
  readonly kind: "managed";
  readonly id: string;
  readonly expectedRuntimeCodeHash: Hex;
  readonly configuration: readonly ConfigurationRule[];
  readonly checks: readonly ReadOnlyCallCheck[];
  readonly storageChecks: readonly StorageWordCheck[];
  readonly semanticChecks: readonly SemanticCheck[];
  readonly enforcement?: ManifestEnforcement;
}

export interface Create2FactoryManagedContractResource extends ManagedContractResourceBase {
  readonly deployment: Create2FactoryDeployment;
  readonly sender?: ManifestSender;
}

export interface CreateXSenderProtectedManagedContractResource extends ManagedContractResourceBase {
  readonly deployment: CreateXCreate2Deployment | CreateXCreate3Deployment;
  readonly sender: ManifestSender;
}

export interface CreateXCreate2ManagedContractResource
  extends CreateXSenderProtectedManagedContractResource {
  readonly deployment: CreateXCreate2Deployment;
}

export interface CreateXCreate3ManagedContractResource
  extends CreateXSenderProtectedManagedContractResource {
  readonly deployment: CreateXCreate3Deployment;
}

export interface CreateXUnguardedManagedContractResource extends ManagedContractResourceBase {
  readonly deployment: CreateXCreate2UnguardedDeployment | CreateXCreate3UnguardedDeployment;
  readonly sender?: ManifestSender;
}

export interface CreateXCrosschainManagedContractResource extends ManagedContractResourceBase {
  readonly deployment: CreateXCreate2CrosschainDeployment | CreateXCreate3CrosschainDeployment;
  readonly sender?: ManifestSender;
}

export interface CreateXSenderCrosschainManagedContractResource
  extends ManagedContractResourceBase {
  readonly deployment:
    | CreateXCreate2SenderCrosschainDeployment
    | CreateXCreate3SenderCrosschainDeployment;
  readonly sender: ManifestSender;
}

/** Closed managed resource set with strategy-specific sender requirements. */
export type ManagedContractResource =
  | Create2FactoryManagedContractResource
  | CreateXSenderProtectedManagedContractResource
  | CreateXUnguardedManagedContractResource
  | CreateXCrosschainManagedContractResource
  | CreateXSenderCrosschainManagedContractResource;

/** Pure deployment authoring input; protected strategies require an exact sender. */
export type DeploymentRecipe =
  | Pick<Create2FactoryManagedContractResource, "deployment" | "sender">
  | Pick<CreateXSenderProtectedManagedContractResource, "deployment" | "sender">
  | Pick<CreateXUnguardedManagedContractResource, "deployment" | "sender">
  | Pick<CreateXCrosschainManagedContractResource, "deployment" | "sender">
  | Pick<CreateXSenderCrosschainManagedContractResource, "deployment" | "sender">;

/** Infrastructure Moesi observes and verifies but never deploys or configures. */
export interface ExternalContractResource {
  readonly kind: "external";
  readonly id: string;
  readonly address: Address;
  readonly expectedRuntimeCodeHash: Hex;
  readonly checks: readonly ReadOnlyCallCheck[];
  readonly storageChecks: readonly StorageWordCheck[];
  readonly semanticChecks: readonly SemanticCheck[];
}

export type ContractResource = ManagedContractResource | ExternalContractResource;

/** One declared resource's address, encoded as a 32-byte ABI address word. */
export interface ResourceAddressWord {
  readonly kind: "resource-address-word";
  readonly resourceId: string;
}

/** Closed, data-only byte expressions; concatenation is deliberately not recursive. */
export type ManifestBytes =
  | Hex
  | ResourceAddressWord
  | { readonly kind: "concat"; readonly parts: readonly (Hex | ResourceAddressWord)[] };

export interface ManifestConfigurationRule
  extends Omit<ConfigurationRule, "readData" | "expectedResult" | "writeData"> {
  readonly readData: ManifestBytes;
  readonly expectedResult: ManifestBytes;
  readonly writeData: ManifestBytes;
}

export interface ManifestCallCheck extends Omit<ReadOnlyCallCheck, "readData" | "expectedResult"> {
  readonly readData: ManifestBytes;
  readonly expectedResult: ManifestBytes;
}

export interface ManifestStorageCheck extends Omit<StorageWordCheck, "expectedWord"> {
  readonly expectedWord: ManifestBytes;
}

interface ManifestAttestations {
  readonly checks: readonly ManifestCallCheck[];
  readonly storageChecks: readonly ManifestStorageCheck[];
  readonly semanticChecks?: readonly SemanticCheck[];
}

interface ManifestConfiguration extends ManifestAttestations {
  readonly configuration: readonly ManifestConfigurationRule[];
}

export type ManifestManagedResource = (
  | Omit<
      Create2FactoryManagedContractResource,
      "configuration" | "checks" | "storageChecks" | "semanticChecks"
    >
  | Omit<
      CreateXSenderProtectedManagedContractResource,
      "configuration" | "checks" | "storageChecks" | "semanticChecks"
    >
  | Omit<
      CreateXUnguardedManagedContractResource,
      "configuration" | "checks" | "storageChecks" | "semanticChecks"
    >
  | Omit<
      CreateXCrosschainManagedContractResource,
      "configuration" | "checks" | "storageChecks" | "semanticChecks"
    >
  | Omit<
      CreateXSenderCrosschainManagedContractResource,
      "configuration" | "checks" | "storageChecks" | "semanticChecks"
    >
) &
  ManifestConfiguration;

export type ManifestExternalResource = Omit<
  ExternalContractResource,
  "checks" | "storageChecks" | "semanticChecks"
> &
  ManifestAttestations;
export type ManifestContractResource = ManifestManagedResource | ManifestExternalResource;

export interface MoesiManifest {
  readonly version: "moesi.manifest/v6";
  readonly contracts: readonly ManifestContractResource[];
}

/** Reviewed plans retain only exact bytes; expressions never reach execution. */
export interface ResolvedMoesiManifest {
  readonly version: "moesi.manifest/v6";
  readonly contracts: readonly ContractResource[];
}
