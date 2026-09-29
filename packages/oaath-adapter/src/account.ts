import type { Address } from "viem";
import { capture, fail, ID, text } from "./boundary.js";

/** Maps a Moesi logical account name to one existing SDK account. */
export interface OAAthAccountBinding {
  readonly address: Address;
  readonly accountId?: string;
}
export interface BoundOAAthAccount {
  readonly address: Address;
  readonly accountId: string;
}
export function parseOAAthAccount(input: unknown): BoundOAAthAccount | undefined {
  if (input === undefined) return undefined;
  let descriptor: Record<string, unknown>;
  try {
    descriptor = capture(input) as Record<string, unknown>;
  } catch {
    return fail("oaath_input_invalid");
  }
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor) ||
    Object.keys(descriptor).some((key) => key !== "address" && key !== "accountId") ||
    !text(descriptor.address, /^0x[0-9a-fA-F]{40}$/) ||
    (descriptor.accountId !== undefined && !text(descriptor.accountId, ID))
  )
    return fail("oaath_input_invalid");
  return Object.freeze({
    address: descriptor.address.toLowerCase() as Address,
    accountId: (descriptor.accountId as string) ?? descriptor.address.toLowerCase(),
  });
}
