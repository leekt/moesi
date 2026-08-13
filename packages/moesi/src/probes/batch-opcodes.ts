import { decodeAbiParameters, type Hex } from "viem";
import {
  isExecutionRevert,
  type ProbeClient,
  type ProbeClientLike,
  parseProbeClient,
} from "./client.js";
import { MoesiProbeError } from "./error.js";

/**
 * Batch opcode probe via one eth_call with state override.
 *
 * Each opcode-support check shares one shape: call the singleton CREATE2
 * factory with calldata `salt(32) || opcodeBytes` and let it succeed or
 * revert. This hand-assembled "multicall that doesn't revert" runtime loops
 * over a packed array of opcode payloads, fires CALL to the singleton for
 * each, and stores the per-call success bit — EVM's CALL pushes 1/0 without
 * propagating reverts, so one unsupported opcode can't sink the batch.
 *
 * Calldata layout: selector(4, ignored) || N(32) || N slots of 32 bytes,
 * each `lengthByte || payload padded to 31 bytes`. Output: ABI `bool[]`.
 */
export const BATCH_OPCODE_BYTECODE =
  "0x60206000526004358060205260005b818110156100615780602002602401803560f81c80826001016104203760200160006000826104006000734e59b44847b379578588920ca78fbf26c0b4956c5af18360200260400152505060010161000e565b506020026040016000f3" as const;

const OVERRIDE_AT = "0x000000000000000000000000000000000000bad1" as const;
const SINGLETON_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/;

/** Raw probe payloads by opcode feature id; byte-identical to moesi 0.12. */
export const OPCODE_PROBE_BYTECODES = Object.freeze({
  returndatasize: "0x3D",
  shl: "0x600060001B",
  shr: "0x600060001C",
  extcodehash: "0x60003F",
  chainid: "0x46",
  selfbalance: "0x47",
  basefee: "0x48",
  push0: "0x5F",
  tload: "0x475C",
  tstore: "0x47475D",
  mcopy: "0x4747475E",
  blobbasefee: "0x4A",
  clz: "0x60001E",
} as const satisfies Record<string, Hex>);

export interface OpcodeProbe {
  readonly id: string;
  readonly bytecode: Hex;
}

async function probeOpcodeDirect(client: ProbeClient, bytecode: Hex): Promise<boolean> {
  try {
    await client.call({
      to: OVERRIDE_AT,
      data: "0x",
      stateOverride: [{ address: OVERRIDE_AT, code: bytecode }],
    });
    return true;
  } catch (error) {
    if (isExecutionRevert(error)) return false;
    throw error;
  }
}

/**
 * Probe up to 255 opcode payloads in one eth_call. Each `bytecode` is the raw
 * opcode payload of 1..31 whole bytes (a zero salt is prepended internally).
 * When the singleton factory is absent on the chain, each probe degrades to
 * one direct state-override call instead.
 */
export async function batchOpcodeProbes(
  clientInput: ProbeClientLike,
  probes: readonly OpcodeProbe[],
): Promise<Record<string, boolean>> {
  const client = parseProbeClient(clientInput);
  if (probes.length === 0) return {};
  if (probes.length > 255) {
    throw new MoesiProbeError("invalid-probe-input", "too many probes (max 255 per batch)");
  }
  const slots: string[] = [];
  for (const probe of probes) {
    if (typeof probe.bytecode !== "string" || !HEX_PATTERN.test(probe.bytecode)) {
      throw new MoesiProbeError("invalid-probe-input", "probe bytecode must be whole-byte hex");
    }
    const raw = probe.bytecode.slice(2);
    const length = raw.length / 2;
    if (length > 31) {
      throw new MoesiProbeError("invalid-probe-input", "probe bytecode must be 1..31 bytes");
    }
    slots.push(length.toString(16).padStart(2, "0") + raw.padEnd(62, "0"));
  }
  const factoryCode = await client.getCode({ address: SINGLETON_FACTORY });
  if (!factoryCode || factoryCode === "0x") {
    const outcomes = await Promise.all(
      probes.map((probe) => probeOpcodeDirect(client, probe.bytecode)),
    );
    return Object.fromEntries(probes.map((probe, index) => [probe.id, outcomes[index] === true]));
  }
  const callData: Hex = `0x00000000${probes.length.toString(16).padStart(64, "0")}${slots.join("")}`;
  const result = await client.call({
    to: OVERRIDE_AT,
    data: callData,
    stateOverride: [{ address: OVERRIDE_AT, code: BATCH_OPCODE_BYTECODE }],
  });
  if (!result.data || result.data === "0x") {
    throw new MoesiProbeError(
      "state-override-unreadable",
      "batch opcode probe returned no data (state override unsupported?)",
    );
  }
  const [bools] = decodeAbiParameters([{ type: "bool[]" }], result.data);
  if (bools.length !== probes.length) {
    throw new MoesiProbeError("state-override-unreadable", "batch opcode probe length mismatch");
  }
  const out: Record<string, boolean> = {};
  probes.forEach((probe, index) => {
    out[probe.id] = bools[index] === true;
  });
  return out;
}
