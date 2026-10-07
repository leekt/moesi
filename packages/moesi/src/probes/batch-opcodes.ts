import type { Hex } from "cetane";
import { toHex } from "cetane/utils";
import { type ProbeClient, type ProbeClientLike, parseProbeClient } from "./client.js";
import { MoesiProbeError } from "./error.js";
import { probeArray, probeBlockNumber, probeBooleans, probeRecord } from "./validation.js";

/** Compiled from test/fixtures/OpcodeProbe.yul with solc 0.8.30, Byzantium, optimizer enabled.
 * Calls isolated state-override accounts with 100,000 gas each and returns EVM
 * success bits as ABI bool[]. RPC errors are never opcode-support evidence. */
export const BATCH_OPCODE_BYTECODE =
  "0x60003560206000528060205260005b818110601f57602082026040016000f35b8060008080808060019661c00001620186a0f1602082026040015201600e56" as const;
const OVERRIDE_AT = "0x000000000000000000000000000000000000bad1" as const;
const PROBE_BASE = 0xc000n;

/** Small opcode payloads evaluated in isolated simulated accounts. */
export const OPCODE_PROBE_BYTECODES = Object.freeze({
  returndatasize: "0x3D",
  shl: "0x600060001B",
  shr: "0x600060001C",
  extcodehash: "0x60003F",
  chainid: "0x46",
  selfbalance: "0x47",
  basefee: "0x48",
  push0: "0x5F",
  tload: "0x60005C",
  tstore: "0x600060005D",
  mcopy: "0x6000600060005E",
  blobbasefee: "0x4A",
  clz: "0x60001E",
} as const satisfies Record<string, Hex>);

export interface OpcodeProbe {
  readonly id: string;
  readonly bytecode: Hex;
}

/** Probe up to 255 uniquely named 1..31-byte payloads in one simulated call.
 * Requires state override; no deployed factory, signer, or transaction is used.
 * A false result means the payload failed within the per-probe gas budget. */
export async function batchOpcodeProbes(
  clientInput: ProbeClientLike,
  probes: readonly OpcodeProbe[],
  blockNumber?: bigint,
): Promise<Readonly<Record<string, boolean>>> {
  const block = probeBlockNumber(blockNumber);
  const seen = new Set<string>();
  const entries = probeArray(probes, 255).map((entry) => {
    const value = probeRecord(entry, "invalid-probe-input", ["id", "bytecode"]);
    if (
      typeof value.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.id) ||
      seen.has(value.id)
    ) {
      throw new MoesiProbeError("invalid-probe-input", "probe IDs must be valid and unique");
    }
    seen.add(value.id);
    if (
      typeof value.bytecode !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2}){1,31}$/.test(value.bytecode)
    ) {
      throw new MoesiProbeError("invalid-probe-input", "probe bytecode must be 1..31 whole bytes");
    }
    return Object.freeze({ id: value.id, bytecode: value.bytecode.toLowerCase() as Hex });
  });
  const client = parseProbeClient(clientInput);
  if (entries.length === 0) return Object.freeze({});
  const values = await simulateProbeCalls(
    client,
    entries.map(({ bytecode }) => bytecode),
    block,
  );
  return Object.freeze(
    Object.fromEntries(entries.map(({ id }, index) => [id, values[index] === true])),
  );
}

/** Internal shared harness for isolated opcode execution. */
export async function simulateProbeCalls(
  client: ProbeClient,
  codes: readonly Hex[],
  blockNumber?: bigint,
): Promise<readonly boolean[]> {
  const result = await client.call({
    to: OVERRIDE_AT,
    data: toHex(codes.length, { size: 32 }),
    ...(blockNumber === undefined ? {} : { blockNumber }),
    stateOverride: [
      { address: OVERRIDE_AT, code: BATCH_OPCODE_BYTECODE },
      ...codes.map((code, index) => ({
        address: toHex(PROBE_BASE + BigInt(index), { size: 20 }),
        code,
      })),
    ],
  });
  return probeBooleans(result.data, codes.length);
}
