import type {
  Abi,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  Hex,
} from "viem";
import type {
  ConfigurationPeer,
  ConfigurationRule,
  ManifestContractResource,
  ManifestSender,
  ResolvedMoesiManifest,
} from "../manifest/types.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "../observation/types.js";

type WithoutAuthoringFields<T> = T extends ManifestContractResource
  ? Omit<T, "id" | "configuration" | "checks" | "storageChecks" | "semanticChecks"> &
      Partial<Pick<T, "checks" | "storageChecks" | "semanticChecks">>
  : never;
export type FleetResource = WithoutAuthoringFields<ManifestContractResource>;
export type FleetAccounts = Readonly<
  Record<string, ManifestSender | ((chainId: number) => ManifestSender)>
>;
export interface FleetDeploymentContext {
  /** Reference another resource's predicted address, including constructor dependencies. */
  address(resourceId: string): Address;
  account(name: string): ManifestSender;
}
export interface FleetContract<A extends Abi = Abi> {
  readonly abi: A;
  /** Return null to exclude this resource from this chain. */
  readonly resource:
    | FleetResource
    | ((chainId: number, context: FleetDeploymentContext) => FleetResource | null);
}
export type FleetContracts = Readonly<Record<string, FleetContract>>;
export type FleetReadName<A extends Abi> = ContractFunctionName<A, "view" | "pure">;
export type FleetWriteName<A extends Abi> = ContractFunctionName<A, "nonpayable" | "payable">;
export interface FleetRead<A extends Abi, N extends FleetReadName<A>> {
  readonly functionName: N;
  readonly args: ContractFunctionArgs<A, "view" | "pure", N>;
}
export interface FleetRule<A extends Abi, R extends FleetReadName<A>, W extends FleetWriteName<A>> {
  readonly id: string;
  readonly read: FleetRead<A, R>;
  readonly expect: ContractFunctionReturnType<A, "view" | "pure", NoInfer<R>>;
  readonly write: {
    readonly functionName: W;
    readonly args: ContractFunctionArgs<A, "nonpayable" | "payable", W>;
  };
  readonly value?: bigint;
  readonly batch?: { readonly key: string; readonly maxRows?: number };
  readonly after?: readonly ConfigurationPeer[];
}
export interface FleetContractContext<A extends Abi> {
  readonly id: string;
  readonly address: Address;
  rule<R extends FleetReadName<A>, W extends FleetWriteName<A>>(
    input: FleetRule<A, R, W>,
  ): ConfigurationRule;
}
export interface FleetLiveRead<A extends Abi, N extends FleetReadName<A>> extends FleetRead<A, N> {
  readonly abi: A;
  readonly chainId: number;
  readonly address: Address;
  /** Explicit simulation caller; never inferred from another chain's account. */
  readonly caller: Address;
}
export interface FleetContext<C extends FleetContracts, A extends FleetAccounts> {
  contract<K extends keyof C & string>(resourceId: K): FleetContractContext<C[K]["abi"]>;
  address(resourceId: keyof C & string): Address;
  has(resourceId: keyof C & string): boolean;
  account(name: keyof A & string): ManifestSender;
  deployedOn(chainId: number, resourceId: keyof C & string): ConfigurationPeer;
  read<const ABI extends Abi, N extends FleetReadName<ABI>>(
    request: FleetLiveRead<ABI, N>,
  ): Promise<ContractFunctionReturnType<ABI, "view" | "pure", N>>;
}
export interface FleetDefinition<C extends FleetContracts, A extends FleetAccounts> {
  readonly chains: readonly number[];
  readonly accounts?: A;
  readonly contracts: C;
  readonly configure?: (
    chainId: number,
    context: FleetContext<C, A>,
  ) =>
    | Partial<Readonly<Record<keyof C & string, readonly ConfigurationRule[]>>>
    | Promise<Partial<Readonly<Record<keyof C & string, readonly ConfigurationRule[]>>>>;
}
export interface FleetReadEvidence {
  readonly chainId: number;
  readonly address: Address;
  readonly caller: Address;
  readonly data: Hex;
  readonly result: Hex;
  readonly snapshot: ChainSnapshot;
}
/** Plain plan inputs with the pinned provenance of baked-in live values. */
export interface CompiledFleetGroup {
  readonly manifest: ResolvedMoesiManifest;
  readonly chains: readonly number[];
  readonly reads: readonly FleetReadEvidence[];
}
export interface FleetCompileOptions {
  /** Compile selected sources while retaining the full catalog for peer references. */
  readonly chains?: readonly number[];
  readonly observer?: MoesiObservationAdapter;
  readonly signal?: AbortSignal;
}
export interface FleetBuilder {
  compile(options?: FleetCompileOptions): Promise<readonly CompiledFleetGroup[]>;
}
