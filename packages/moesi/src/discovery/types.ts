import type { Address, Hex } from "viem";
import type { ChainSnapshot } from "../observation/types.js";

export const MOESI_DISCOVERY_VERSION = "moesi.discovery/v1" as const;
export const MAX_DISCOVERY_READS = 4096;

export interface DiscoveryRoleQuery {
  readonly role: Hex;
  readonly account: Address;
}

export interface DiscoveryResourceRequest {
  readonly address: Address;
  /** Exact nonzero sender for every requested view call. */
  readonly caller: Address;
  readonly erc1967?: boolean;
  readonly ownable?: boolean;
  readonly roles?: readonly DiscoveryRoleQuery[];
}

export interface MoesiDiscoverRequest {
  readonly chains: readonly number[];
  readonly resources: readonly DiscoveryResourceRequest[];
}

export type DiscoveryValue<T> =
  | { readonly kind: "readable"; readonly value: T }
  | {
      readonly kind: "unreadable";
      readonly reason: "unavailable" | "read-failed" | "invalid-response";
    };

/** Slot/call evidence only; it does not establish the contract's actual delegatecall behavior. */
export interface ERC1967Discovery {
  readonly implementation: DiscoveryValue<Address>;
  readonly admin: DiscoveryValue<Address>;
  readonly beacon: DiscoveryValue<Address>;
  readonly target:
    | { readonly kind: "implementation"; readonly address: Address }
    | {
        readonly kind: "beacon";
        readonly address: Address;
        readonly implementation: DiscoveryValue<Address>;
      }
    | { readonly kind: "empty" | "conflict" | "unreadable" };
}

export interface RoleDiscovery extends DiscoveryRoleQuery {
  readonly member: DiscoveryValue<boolean>;
  readonly adminRole: DiscoveryValue<Hex>;
}

export type ResourceDiscovery = { readonly address: Address; readonly caller: Address } & (
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: "read-failed" | "invalid-response" }
  | {
      readonly kind: "deployed";
      readonly runtimeCode: Hex;
      readonly runtimeCodeHash: Hex;
      /** Null means the probe was not requested. */
      readonly erc1967: ERC1967Discovery | null;
      readonly owner: DiscoveryValue<Address> | null;
      readonly roles: readonly RoleDiscovery[];
    }
);

export type ChainDiscovery = { readonly chainId: number } & (
  | {
      readonly kind: "observed";
      readonly snapshot: ChainSnapshot;
      readonly resources: readonly ResourceDiscovery[];
    }
  | {
      readonly kind: "unreadable";
      readonly reason: "snapshot-unreadable" | "ancestry-unreadable" | "snapshot-not-canonical";
    }
);

export interface MoesiDiscoveryResult {
  readonly version: typeof MOESI_DISCOVERY_VERSION;
  readonly chains: readonly ChainDiscovery[];
}
