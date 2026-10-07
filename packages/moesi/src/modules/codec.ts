import type { Address, Hex } from "cetane";
import { compareAscii, deepFreeze, hashCanonical } from "../internal.js";
import type { ChainSnapshot } from "../observation/types.js";
import type {
  AccountModuleEntry,
  AccountModuleInventory,
  AccountModulesExpectation,
  AccountModulesObservation,
} from "./types.js";

const fail = (): never => {
  throw new Error("invalid_account_module_evidence");
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !keys.includes(key) || !descriptor || !("value" in descriptor))
      return fail();
    output[key] = descriptor.value;
  }
  return output;
}
function array(value: unknown, max = 256): unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor || !("value" in descriptor)) return fail();
    return descriptor.value;
  });
}
function hex(value: unknown, bytes: number): Hex {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value))
    return fail();
  return value.toLowerCase() as Hex;
}
function address(value: unknown): Address {
  const result = hex(value, 20);
  if (result === `0x${"00".repeat(20)}`) return fail();
  return result;
}
function decimal(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 1n << 256n
  )
    return fail();
  return value;
}
function context(value: unknown): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:0101[0-9a-f]{40}|0102[0-9a-f]{8}0{32}|02[0-9a-f]{40}|03[0-9a-f]{8})$/i.test(value)
  )
    return fail();
  return value.toLowerCase() as Hex;
}
export function moduleKey(entry: AccountModuleEntry): string {
  switch (entry.kind) {
    case "root":
      return "root";
    case "validator":
    case "executor":
      return `${entry.kind}:${entry.address}`;
    case "fallback":
      return `fallback:${entry.selector}`;
    case "permission":
      return `permission:${entry.id}`;
    case "hook":
      return `hook:${entry.context}`;
  }
}
function key(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(root|(?:validator|executor):0x[0-9a-f]{40}|(?:fallback|permission):0x[0-9a-f]{8}|hook:0x(?:0101[0-9a-f]{40}|0102[0-9a-f]{8}0{32}|02[0-9a-f]{40}|03[0-9a-f]{8}))$/.test(
      value,
    )
  )
    return fail();
  return value;
}
export function parseModuleEntry(value: unknown): AccountModuleEntry {
  const item = record(value, [
    "kind",
    "id",
    "address",
    "selector",
    "signer",
    "policies",
    "context",
  ]);
  let result: AccountModuleEntry;
  if (item.kind === "root") {
    const id = hex(item.id, 21);
    if (!/^0x(?:01[0-9a-f]{40}|02[0-9a-f]{8}0{32})$/.test(id)) return fail();
    result = { kind: item.kind, id };
  } else if (item.kind === "validator" || item.kind === "executor")
    result = { kind: item.kind, address: address(item.address) };
  else if (item.kind === "fallback")
    result = { kind: item.kind, selector: hex(item.selector, 4), address: address(item.address) };
  else if (item.kind === "permission") {
    const policies = array(item.policies, 64).map(address);
    if (new Set(policies).size !== policies.length) return fail();
    result = { kind: item.kind, id: hex(item.id, 4), signer: address(item.signer), policies };
  } else if (item.kind === "hook")
    result = { kind: item.kind, context: context(item.context), address: address(item.address) };
  else return fail();
  if (Object.keys(item).length !== Object.keys(result).length) return fail();
  return result;
}
function entries(value: unknown): AccountModuleEntry[] {
  const result = array(value).map(parseModuleEntry);
  if (new Set(result.map(moduleKey)).size !== result.length) return fail();
  return result.sort((a, b) => compareAscii(moduleKey(a), moduleKey(b)));
}
export function parseAccountModules(value: unknown): AccountModulesExpectation {
  const item = record(value, ["profile", "fromBlock", "entries", "removals", "accountId"]);
  if (item.profile !== "kernel-0.4.0") return fail();
  const expected = entries(item.entries);
  const removals =
    item.removals === undefined
      ? []
      : array(item.removals, 64).map((value) => {
          const removal = record(value, ["key", "data"]);
          const identity = key(removal.key);
          if (identity === "root" || expected.some((entry) => moduleKey(entry) === identity))
            return fail();
          if (
            typeof removal.data !== "string" ||
            !/^0x(?:[0-9a-fA-F]{2}){4,65536}$/.test(removal.data)
          )
            return fail();
          return { key: identity, data: removal.data.toLowerCase() as Hex };
        });
  if (new Set(removals.map(({ key }) => key)).size !== removals.length) return fail();
  if (
    removals.length &&
    (typeof item.accountId !== "string" ||
      !/^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/.test(item.accountId))
  )
    return fail();
  if (!removals.length && item.accountId !== undefined) return fail();
  return deepFreeze({
    profile: item.profile,
    fromBlock: decimal(item.fromBlock),
    entries: expected,
    ...(removals.length
      ? {
          removals: removals.sort((a, b) => compareAscii(a.key, b.key)),
          accountId: item.accountId as string,
        }
      : {}),
  });
}
export function parseModuleInventory(
  value: unknown,
  bound: { account: Address; snapshot: ChainSnapshot; expectation: AccountModulesExpectation },
): AccountModuleInventory {
  const item = record(value, [
    "profile",
    "account",
    "snapshot",
    "entries",
    "checked",
    "history",
    "complete",
    "reason",
  ]);
  const snapshot = record(item.snapshot, ["chainId", "blockNumber", "blockHash"]);
  const history = record(item.history, ["fromBlock", "toBlock", "nextBlock", "complete", "counts"]);
  const observed = entries(item.entries);
  const checked = array(item.checked, 1024).map(key).sort(compareAscii);
  if (
    new Set(checked).size !== checked.length ||
    item.profile !== bound.expectation.profile ||
    address(item.account) !== bound.account ||
    snapshot.chainId !== bound.snapshot.chainId ||
    decimal(snapshot.blockNumber) !== bound.snapshot.blockNumber ||
    hex(snapshot.blockHash, 32) !== bound.snapshot.blockHash
  )
    return fail();
  const fromBlock = decimal(history.fromBlock),
    toBlock = decimal(history.toBlock),
    nextBlock = decimal(history.nextBlock);
  if (
    fromBlock !== bound.expectation.fromBlock ||
    toBlock !== bound.snapshot.blockNumber ||
    BigInt(fromBlock) > BigInt(toBlock) ||
    BigInt(nextBlock) < BigInt(fromBlock) ||
    BigInt(nextBlock) > BigInt(toBlock) + 1n ||
    history.complete !== (BigInt(nextBlock) === BigInt(toBlock) + 1n)
  )
    return fail();
  if (
    typeof item.complete !== "boolean" ||
    (item.complete
      ? history.complete !== true || item.reason !== null
      : !["partial-history", "unknown-context", "budget"].includes(item.reason as string))
  )
    return fail();
  const counts = array(history.counts, 1024)
    .map((value) => {
      const row = record(value, ["type", "address", "installed", "uninstalled"]);
      for (const field of [row.installed, row.uninstalled])
        if (
          typeof field !== "number" ||
          !Number.isSafeInteger(field) ||
          field < 0 ||
          field > 1_000_000
        )
          return fail();
      return {
        type: decimal(row.type),
        address: address(row.address),
        installed: row.installed as number,
        uninstalled: row.uninstalled as number,
      };
    })
    .sort((a, b) => compareAscii(`${a.type}:${a.address}`, `${b.type}:${b.address}`));
  if (new Set(counts.map((row) => `${row.type}:${row.address}`)).size !== counts.length)
    return fail();
  return deepFreeze({
    profile: item.profile,
    account: bound.account,
    snapshot: { ...bound.snapshot },
    entries: observed,
    checked,
    history: { fromBlock, toBlock, nextBlock, complete: history.complete, counts },
    complete: item.complete,
    reason: item.reason,
  } as AccountModuleInventory);
}
export function compareAccountModules(
  expected: AccountModulesExpectation,
  inventory: AccountModuleInventory,
): AccountModulesObservation {
  const wanted = new Map(expected.entries.map((entry) => [moduleKey(entry), entry]));
  const found = new Map(inventory.entries.map((entry) => [moduleKey(entry), entry]));
  const checked = new Set(inventory.checked);
  const differences: Extract<
    AccountModulesObservation,
    { inventory: unknown }
  >["differences"][number][] = [];
  for (const [key, observed] of found) {
    const expected = wanted.get(key) ?? null;
    if (!expected || hashCanonical(expected) !== hashCanonical(observed))
      differences.push({ key, kind: expected ? "changed" : "unexpected", expected, observed });
  }
  for (const [key, expected] of wanted)
    if (!found.has(key) && (inventory.complete || checked.has(key)))
      differences.push({ key, kind: "missing", expected, observed: null });
  differences.sort((a, b) => compareAscii(a.key, b.key));
  return deepFreeze({
    kind: differences.length ? "drifted" : inventory.complete ? "satisfied" : "incomplete",
    inventory,
    differences,
  });
}
