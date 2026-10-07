import type { Address, Hex } from "cetane";
import type { ChainSnapshot } from "../observation/types.js";

/** Exact installed authority. Policy order and hook context are significant. */
export type AccountModuleEntry =
  | { readonly kind: "root"; readonly id: Hex }
  | { readonly kind: "validator" | "executor"; readonly address: Address }
  | { readonly kind: "fallback"; readonly selector: Hex; readonly address: Address }
  | {
      readonly kind: "permission";
      readonly id: Hex;
      readonly signer: Address;
      readonly policies: readonly Address[];
    }
  | { readonly kind: "hook"; readonly context: Hex; readonly address: Address };

export interface AccountModulesExpectation {
  readonly profile: "kernel-0.4.0";
  /** Inclusive history origin, normally the account's deployment block. */
  readonly fromBlock: string;
  readonly entries: readonly AccountModuleEntry[];
  /** Exact reviewed self-calls for explicitly identified unexpected entries. */
  readonly removals?: readonly { readonly key: string; readonly data: Hex }[];
  /** Required for removals; binds the selected provider to this logical account. */
  readonly accountId?: string;
}

export interface AccountModuleInventory {
  readonly profile: "kernel-0.4.0";
  readonly account: Address;
  readonly snapshot: ChainSnapshot;
  /** Positive entries confirmed from state, never event-only guesses. */
  readonly entries: readonly AccountModuleEntry[];
  /** Identities explicitly checked, including negative installation results. */
  readonly checked: readonly string[];
  readonly history: {
    readonly fromBlock: string;
    readonly toBlock: string;
    readonly nextBlock: string;
    readonly complete: boolean;
    readonly counts: readonly {
      readonly type: string;
      readonly address: Address;
      readonly installed: number;
      readonly uninstalled: number;
    }[];
  };
  readonly complete: boolean;
  readonly reason: "partial-history" | "unknown-context" | "budget" | null;
}

export type AccountModulesObservation =
  | {
      readonly kind: "unreadable";
      readonly reason: "unavailable" | "read-failed" | "invalid-response";
    }
  | {
      [K in "satisfied" | "drifted" | "incomplete"]: {
        readonly kind: K;
        readonly inventory: AccountModuleInventory;
        readonly differences: readonly {
          readonly key: string;
          readonly kind: "unexpected" | "missing" | "changed";
          readonly expected: AccountModuleEntry | null;
          readonly observed: AccountModuleEntry | null;
        }[];
      };
    }["satisfied" | "drifted" | "incomplete"];
