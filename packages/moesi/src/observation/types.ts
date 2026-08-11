import type { Address, Hex } from "viem";

export interface ChainSnapshot {
  readonly chainId: number;
  /** Canonical unsigned decimal string so snapshots remain JSON-safe. */
  readonly blockNumber: string;
  readonly blockHash: Hex;
}

export interface SnapshotReference {
  /** Canonical unsigned decimal string so references remain JSON-safe. */
  readonly blockNumber: string;
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
  readonly caller: Address;
  readonly snapshot: ChainSnapshot;
}

export interface StorageReadRequest {
  readonly chainId: number;
  readonly address: Address;
  readonly slot: Hex;
  readonly snapshot: ChainSnapshot;
}

export interface BlockAncestryRequest {
  readonly chainId: number;
  readonly ancestor: SnapshotReference;
  readonly descendant: ChainSnapshot;
}

/**
 * Caller-owned read boundary. Every read is pinned to the exact snapshot
 * captured by `captureSnapshot`; implementations must not fall back to a
 * different block. Failures and malformed responses become structured
 * `unreadable` cells, never absence or drift. Static calls must use the exact
 * requested caller, and ancestry checks must follow block hashes rather than
 * infer lineage from heights alone.
 */
export interface MoesiObservationAdapter {
  captureSnapshot(chainId: number): Promise<SnapshotReference | unknown>;
  readCode(request: CodeReadRequest): Promise<Hex | unknown>;
  readCall(request: CallReadRequest): Promise<Hex | unknown>;
  readStorage?(request: StorageReadRequest): Promise<Hex | unknown>;
  /** Proves both references remain on one canonical chain. */
  checkBlockAncestry(request: BlockAncestryRequest): Promise<boolean | unknown>;
}

export type RuntimeCodeObservation =
  | { readonly kind: "readable"; readonly code: Hex }
  | { readonly kind: "unreadable"; readonly reason: "read-failed" | "invalid-response" };

export type CallObservation =
  | { readonly kind: "readable"; readonly result: Hex }
  | { readonly kind: "unreadable"; readonly reason: "read-failed" | "invalid-response" };

export type StorageObservation =
  | { readonly kind: "readable"; readonly word: Hex }
  | {
      readonly kind: "unreadable";
      readonly reason: "unavailable" | "read-failed" | "invalid-response";
    };
