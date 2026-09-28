import { type Address, concatHex, type Hex, padHex } from "viem";
import type { DiscoveryRoleQuery, DiscoveryValue, RoleDiscovery } from "../discovery/types.js";
import { observeCall } from "./observe.js";
import type { ChainSnapshot, MoesiObservationAdapter } from "./types.js";

const WORD = /^0x[0-9a-f]{64}$/;
const ADDRESS_WORD = /^0x0{24}[0-9a-f]{40}$/;

export interface SemanticReadContext {
  readonly observer: MoesiObservationAdapter;
  readonly snapshot: ChainSnapshot;
  readonly address: Address;
  readonly caller: Address;
}

export function decodeAddressWord(value: Hex): DiscoveryValue<Address> {
  return ADDRESS_WORD.test(value)
    ? { kind: "readable", value: `0x${value.slice(26)}` }
    : { kind: "unreadable", reason: "invalid-response" };
}

export async function readAddressCall(
  context: SemanticReadContext,
  data: Hex,
): Promise<DiscoveryValue<Address>> {
  const result = await readWordCall(context, data);
  return result.kind === "unreadable" ? result : decodeAddressWord(result.value);
}

export function observeOwner(context: SemanticReadContext): Promise<DiscoveryValue<Address>> {
  return readAddressCall(context, "0x8da5cb5b");
}

export async function observeRole(
  context: SemanticReadContext,
  query: DiscoveryRoleQuery,
): Promise<RoleDiscovery> {
  const result = await readWordCall(
    context,
    concatHex(["0x91d14854", query.role, padHex(query.account, { size: 32 })]),
  );
  const member: DiscoveryValue<boolean> =
    result.kind === "unreadable"
      ? result
      : BigInt(result.value) <= 1n
        ? { kind: "readable", value: result.value.endsWith("1") }
        : { kind: "unreadable", reason: "invalid-response" };
  const adminRole = await readWordCall(context, concatHex(["0x248a9ca3", query.role]));
  return { ...query, member, adminRole };
}

async function readWordCall(context: SemanticReadContext, data: Hex): Promise<DiscoveryValue<Hex>> {
  const result = await observeCall(
    context.observer,
    Object.freeze({
      chainId: context.snapshot.chainId,
      target: context.address,
      caller: context.caller,
      snapshot: context.snapshot,
      data,
    }),
  );
  if (result.kind === "unreadable") return result;
  return WORD.test(result.result)
    ? { kind: "readable", value: result.result }
    : { kind: "unreadable", reason: "invalid-response" };
}
