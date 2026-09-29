import type { Address } from "viem";
import { capture, fail, ID, optionalField, record, text } from "./boundary.js";

/** Maps a Moesi logical account name to one existing SDK account. */
export interface OAAthAccountBinding {
  readonly kind: "existing";
  readonly address: Address;
  readonly accountId?: string;
}
export interface BoundOAAthAccount {
  readonly address: Address;
  readonly accountId: string;
}
export function parseOAAthAccount(input: unknown): BoundOAAthAccount | undefined {
  if (input === undefined) return undefined;
  const raw = capture(input);
  const keys =
    optionalField(raw, "accountId") === undefined
      ? ["kind", "address"]
      : ["kind", "address", "accountId"];
  const descriptor = record(raw, keys);
  if (
    descriptor.kind !== "existing" ||
    !text(descriptor.address, /^0x[0-9a-fA-F]{40}$/) ||
    (descriptor.accountId !== undefined && !text(descriptor.accountId, ID))
  )
    return fail("oaath_input_invalid");
  return Object.freeze({
    address: descriptor.address.toLowerCase() as Address,
    accountId: (descriptor.accountId as string) ?? descriptor.address.toLowerCase(),
  });
}
