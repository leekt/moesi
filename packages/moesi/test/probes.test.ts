import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  BATCH_CHECK_BYTECODE,
  BATCH_OPCODE_BYTECODE,
  batchCheckCode,
  batchOpcodeProbes,
  listKnownFeatures,
  MoesiProbeError,
  OPCODE_PROBE_BYTECODES,
  runFeatureProbe,
} from "../src/index.js";

const FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const OTHER = "0x1111111111111111111111111111111111111111";

function encodeBools(values: readonly boolean[]): Hex {
  return encodeAbiParameters([{ type: "bool[]" }], [values]);
}

describe("batchCheckCode", () => {
  it("checks every address through one state-override call with pinned calldata", async () => {
    const call = vi.fn(async ({ to, data, stateOverride }) => {
      expect(to).toBe("0x000000000000000000000000000000000000bad0");
      expect(stateOverride).toEqual([
        { address: "0x000000000000000000000000000000000000bad0", code: BATCH_CHECK_BYTECODE },
      ]);
      expect(data.startsWith("0x00000000")).toBe(true);
      const [addresses] = decodeAbiParameters(
        [{ type: "address[]" }],
        `0x${data.slice(10)}` as Hex,
      );
      expect(addresses.map((a: string) => a.toLowerCase())).toEqual([FACTORY, OTHER]);
      return { data: encodeBools([true, false]) };
    });
    const getCode = vi.fn();
    const result = await batchCheckCode({ call, getCode }, [
      FACTORY,
      OTHER.toUpperCase().replace("0X", "0x"),
    ]);
    expect(result).toEqual({
      via: "state-override",
      count: 2,
      results: { [FACTORY]: true, [OTHER]: false },
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(getCode).not.toHaveBeenCalled();
  });

  it("deduplicates case-variant addresses and returns empty input untouched", async () => {
    const call = vi.fn(async () => ({ data: encodeBools([true]) }));
    const one = await batchCheckCode({ call, getCode: vi.fn() }, [
      FACTORY,
      FACTORY.toUpperCase().replace("0X", "0x"),
    ]);
    expect(one.count).toBe(1);
    const empty = await batchCheckCode({ call: vi.fn(), getCode: vi.fn() }, []);
    expect(empty).toEqual({ results: {}, via: "state-override", count: 0 });
  });

  it("falls back to per-address getCode when state override is unreadable", async () => {
    const call = vi.fn(async () => {
      throw new Error("state override not supported");
    });
    const getCode = vi.fn(
      async ({ address }: { address: string }): Promise<Hex> =>
        address === FACTORY ? "0x60" : "0x",
    );
    const result = await batchCheckCode({ call, getCode }, [FACTORY, OTHER]);
    expect(result.via).toBe("getCode-fallback");
    expect(result.results).toEqual({ [FACTORY]: true, [OTHER]: false });
  });

  it("throws a structured probe error instead of degrading when fallback is none", async () => {
    const call = vi.fn(async () => {
      throw new Error("credential-bearing transport detail");
    });
    const getCode = vi.fn();
    await expect(
      batchCheckCode({ call, getCode }, [FACTORY], { fallback: "none" }),
    ).rejects.toMatchObject({ name: "MoesiProbeError", code: "state-override-unreadable" });
    expect(getCode).not.toHaveBeenCalled();
  });

  it("rejects non-addresses and missing client capabilities at the boundary", async () => {
    await expect(
      batchCheckCode({ call: vi.fn(), getCode: vi.fn() }, ["not-an-address"]),
    ).rejects.toMatchObject({ code: "invalid-address" });
    await expect(batchCheckCode({} as never, [FACTORY])).rejects.toMatchObject({
      code: "missing-transport",
    });
  });
});

describe("batchOpcodeProbes", () => {
  it("isolates payloads in one pinned simulated call without consulting a factory", async () => {
    const call = vi.fn(async ({ to, data, stateOverride, blockNumber }) => {
      expect(to).toBe("0x000000000000000000000000000000000000bad1");
      expect(data).toBe(`0x${"2".padStart(64, "0")}`);
      expect(blockNumber).toBe(12n);
      expect(stateOverride).toEqual([
        { address: to, code: BATCH_OPCODE_BYTECODE },
        { address: "0x000000000000000000000000000000000000c000", code: "0x5f" },
        { address: "0x000000000000000000000000000000000000c001", code: "0x6000600060005e" },
      ]);
      return { data: encodeBools([true, false]) };
    });
    const getCode = vi.fn();
    await expect(
      batchOpcodeProbes(
        { call, getCode },
        [
          { id: "push0", bytecode: OPCODE_PROBE_BYTECODES.push0 },
          { id: "mcopy", bytecode: OPCODE_PROBE_BYTECODES.mcopy },
        ],
        12n,
      ),
    ).resolves.toEqual({ push0: true, mcopy: false });
    expect(getCode).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not infer an unsupported opcode from provider error prose", async () => {
    const call = vi.fn(async () => {
      throw new Error("execution reverted: synthetic secret");
    });
    await expect(
      batchOpcodeProbes({ call, getCode: vi.fn() }, [{ id: "push0", bytecode: "0x5f" }]),
    ).rejects.toMatchObject({
      code: "transport-failed",
      message: "probe RPC request did not produce evidence",
    });
  });

  it("rejects malformed probe input with structured codes", async () => {
    const client = { call: vi.fn(), getCode: vi.fn() };
    await expect(
      batchOpcodeProbes(client, [{ id: "bad", bytecode: "0x1" as Hex }]),
    ).rejects.toMatchObject({ code: "invalid-probe-input" });
    await expect(
      batchOpcodeProbes(client, [{ id: "long", bytecode: `0x${"00".repeat(32)}` as Hex }]),
    ).rejects.toMatchObject({ code: "invalid-probe-input" });
    await expect(
      batchOpcodeProbes(
        client,
        Array.from({ length: 256 }, (_, index) => ({ id: `p${index}`, bytecode: "0x5f" as Hex })),
      ),
    ).rejects.toMatchObject({ code: "invalid-probe-input" });
    await expect(batchOpcodeProbes(client, [])).resolves.toEqual({});
    expect(MoesiProbeError.name).toBe("MoesiProbeError");
  });
});

describe("feature catalog", () => {
  it("lists the complete known catalog, newest hardfork first", () => {
    const features = listKnownFeatures();
    expect(features).toHaveLength(22);
    expect(features[0]).toEqual({
      id: "clz",
      name: "CLZ (0x1E)",
      hardfork: "Osaka (Fusaka)",
      checkType: "opcode",
      category: "evm",
      description: "Count leading zero bits in a 256-bit value (EIP-7939)",
    });
    expect(features.at(-1)).toMatchObject({ id: "multicall3", category: "protocol" });
    expect(features.filter(({ checkType }) => checkType === "opcode")).toHaveLength(14);
  });

  it("uses structured simulated evidence for single opcode features", async () => {
    const call = vi.fn(async () => ({ data: encodeBools([true]) }));
    const getCode = vi.fn();
    await expect(runFeatureProbe({ call, getCode }, "push0")).resolves.toEqual({ supported: true });
    expect(getCode).not.toHaveBeenCalled();
  });

  it("maps failures to structured outcomes without raw provider text", async () => {
    const revert = vi.fn(async () => ({ data: encodeBools([false]) }));
    const getCode = vi.fn(async (): Promise<Hex> => "0x60");
    await expect(runFeatureProbe({ call: revert, getCode }, "push0")).resolves.toEqual({
      supported: false,
    });
    const transport = vi.fn(async () => {
      throw new Error("https://user:secret@rpc.example failed");
    });
    const outcome = await runFeatureProbe({ call: transport, getCode }, "push0");
    expect(outcome).toEqual({ supported: null, error: "transport-failed" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    await expect(runFeatureProbe({ call: vi.fn(), getCode }, "no-such-feature")).resolves.toEqual({
      supported: null,
      error: "unknown-feature",
    });
    // Block-header checks need getBlock; absence is a structured outcome.
    await expect(runFeatureProbe({ call: vi.fn(), getCode }, "baseFeeHeader")).resolves.toEqual({
      supported: null,
      error: "unsupported-client",
    });
  });
});
