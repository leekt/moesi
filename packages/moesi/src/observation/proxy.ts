import type { Address, Hex } from "cetane";
import type { DiscoveryValue, ERC1967Discovery } from "../discovery/types.js";
import { observeStorage } from "./observe.js";
import { decodeAddressWord, readAddressCall, type SemanticReadContext } from "./ownership.js";

// ERC-1967: https://eips.ethereum.org/EIPS/eip-1967
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const ERC1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const ERC1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export async function observeERC1967(context: SemanticReadContext): Promise<ERC1967Discovery> {
  const implementation = await readSlot(context, ERC1967_IMPLEMENTATION_SLOT);
  const admin = await readSlot(context, ERC1967_ADMIN_SLOT);
  const beacon = await readSlot(context, ERC1967_BEACON_SLOT);
  let target: ERC1967Discovery["target"];
  if (implementation.kind === "unreadable" || beacon.kind === "unreadable") {
    target = { kind: "unreadable" };
  } else if (implementation.value !== ZERO_ADDRESS && beacon.value !== ZERO_ADDRESS) {
    target = { kind: "conflict" };
  } else if (implementation.value !== ZERO_ADDRESS) {
    target = { kind: "implementation", address: implementation.value };
  } else if (beacon.value !== ZERO_ADDRESS) {
    target = {
      kind: "beacon",
      address: beacon.value,
      implementation: await readAddressCall({ ...context, address: beacon.value }, "0x5c60da1b"),
    };
  } else {
    target = { kind: "empty" };
  }
  return { implementation, admin, beacon, target };
}

async function readSlot(context: SemanticReadContext, slot: Hex): Promise<DiscoveryValue<Address>> {
  const result = await observeStorage(
    context.observer,
    Object.freeze({
      chainId: context.snapshot.chainId,
      address: context.address,
      snapshot: context.snapshot,
      slot,
    }),
  );
  return result.kind === "unreadable" ? result : decodeAddressWord(result.word);
}
