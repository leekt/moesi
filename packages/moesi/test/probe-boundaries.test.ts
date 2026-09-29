import { encodeAbiParameters, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  batchCheckCode,
  batchOpcodeProbes,
  listKnownFeatures,
  runFeatureProbe,
} from "../src/index.js";

const ADDRESS = "0x000000000000000000000000000000000000bad0";
const bools = (values: readonly boolean[]) => encodeAbiParameters([{ type: "bool[]" }], [values]);
const baseClient = () => ({
  call: vi.fn(async () => ({ data: bools([true]) })),
  getCode: vi.fn(async () => "0x" as Hex),
});

describe("probe trust boundaries", () => {
  it("excludes the query's own helper from code-presence evidence", async () => {
    const client = baseClient();
    const call = vi.fn(async (args) => {
      expect(args.to).not.toBe(ADDRESS);
      return { data: bools([false]) };
    });
    const result = await batchCheckCode({ ...client, call }, [ADDRESS], { fallback: "none" });
    expect(result.results[ADDRESS]).toBe(false);
  });

  it.each([
    null,
    "none",
    { fallback: "typo" },
    { blockNumber: -1n },
    { blockNumber: 1 },
    { unexpected: true },
  ])("rejects invalid options before RPC: %s", async (options) => {
    const client = baseClient();
    await expect(batchCheckCode(client, [ADDRESS], options as never)).rejects.toMatchObject({
      code: "invalid-probe-input",
    });
    expect(client.call).not.toHaveBeenCalled();
    expect(client.getCode).not.toHaveBeenCalled();
  });

  it("does not turn malformed per-address responses into deployment evidence", async () => {
    for (const invalid of ["0x1", "junk", null, 123, {}]) {
      const client = { call: vi.fn(async () => ({})), getCode: vi.fn(async () => invalid) };
      const result = await batchCheckCode(client as never, [ADDRESS]);
      expect(result).toEqual({ via: "getCode-fallback", count: 1, results: {} });
    }
  });

  it.each([
    "0x",
    `${bools([true])}00`,
    bools([true, true]),
    `0x${"20".padStart(64, "0")}${"1".padStart(64, "0")}${"2".padStart(64, "0")}`,
  ])("rejects noncanonical batch evidence", async (data) => {
    const client = { ...baseClient(), call: vi.fn(async () => ({ data })) };
    await expect(
      batchOpcodeProbes(client as never, [{ id: "push0", bytecode: "0x5f" }]),
    ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(
      batchCheckCode(client as never, [ADDRESS], { fallback: "none" }),
    ).rejects.toMatchObject({ code: "state-override-unreadable" });
  });

  it("snapshots payload identities and options before awaiting untrusted work", async () => {
    const probes = [{ id: "original", bytecode: "0x5f" as Hex }];
    const options = { fallback: "none" as const, blockNumber: 4n };
    const client = {
      ...baseClient(),
      call: vi.fn(async (args) => {
        probes[0]!.id = "changed";
        probes.push({ id: "extra", bytecode: "0xfe" });
        options.blockNumber = 99n;
        expect(args.blockNumber).toBe(4n);
        return { data: bools([true]) };
      }),
    };
    expect(await batchOpcodeProbes(client, probes, options.blockNumber)).toEqual({
      original: true,
    });
    const fallbackCalls: (bigint | undefined)[] = [];
    options.blockNumber = 4n;
    const fallbackClient = {
      call: async () => {
        options.blockNumber = 99n;
        throw new Error("synthetic transport");
      },
      getCode: async (args: { blockNumber?: bigint }) => {
        fallbackCalls.push(args.blockNumber);
        return "0x" as const;
      },
    };
    await batchCheckCode(fallbackClient, [ADDRESS], {
      get blockNumber() {
        return options.blockNumber;
      },
    });
    expect(fallbackCalls).toEqual([4n]);
  });

  it.each(
    [
      [
        { id: "same", bytecode: "0x5f" },
        { id: "same", bytecode: "0xfe" },
      ],
      [{ id: "__proto__", bytecode: "0x5f" }],
      [{ id: "valid", bytecode: "0x5f", unknown: 1 }],
      [null],
      new Array(2),
    ].map((probes) => [probes]),
  )("rejects invalid or ambiguous probe identities before calling RPC", async (probes) => {
    const client = baseClient();
    await expect(batchOpcodeProbes(client, probes as never)).rejects.toMatchObject({
      code: "invalid-probe-input",
    });
    expect(client.call).not.toHaveBeenCalled();
  });

  it("scrubs client accessors and response accessors without retaining their causes", async () => {
    const client = {
      get call() {
        throw new Error("synthetic private diagnostic");
      },
      getCode: vi.fn(),
    };
    await expect(batchOpcodeProbes(client as never, [])).rejects.toMatchObject({
      code: "missing-transport",
    });
    const valid = {
      ...baseClient(),
      call: async () => ({
        get data() {
          throw new Error("synthetic private diagnostic");
        },
      }),
    };
    const result = await runFeatureProbe(valid, "push0");
    expect(result).toEqual({ supported: null, error: "invalid-response" });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});

describe("feature evidence", () => {
  it("uses structured RPC method codes and never error prose", async () => {
    const client = baseClient();
    for (const code of [-32601, -32004, 4200]) {
      const result = await runFeatureProbe(
        {
          ...client,
          request: async () => {
            throw { cause: { code } };
          },
        },
        "accessList",
      );
      expect(result).toEqual({ supported: false });
    }
    expect(
      await runFeatureProbe(
        {
          ...client,
          request: async () => {
            throw new Error("method not found invalid insufficient");
          },
        },
        "accessList",
      ),
    ).toEqual({ supported: null, error: "transport-failed" });
    const read = vi.fn(() => -32601);
    expect(
      await runFeatureProbe(
        {
          ...client,
          request: async () => {
            throw Object.defineProperty({}, "code", { get: read });
          },
        },
        "accessList",
      ),
    ).toEqual({ supported: null, error: "transport-failed" });
    expect(read).not.toHaveBeenCalled();
  });

  it("requires actual access-list response data", async () => {
    const client = baseClient();
    for (const value of [
      null,
      {},
      { accessList: [], gasUsed: "0x00" },
      { accessList: [], gasUsed: "0x1", error: "synthetic" },
      { accessList: [{ address: ADDRESS, storageKeys: ["0x00"] }], gasUsed: "0x1" },
    ]) {
      expect(
        await runFeatureProbe({ ...client, request: async () => value }, "accessList"),
      ).toEqual({ supported: null, error: "invalid-response" });
    }
    expect(
      await runFeatureProbe(
        { ...client, request: async () => ({ accessList: [], gasUsed: "0x5208" }) },
        "accessList",
      ),
    ).toEqual({ supported: true });
  });

  it("does not infer PREVRANDAO from zero or missing block difficulty", async () => {
    const client = baseClient();
    expect(
      await runFeatureProbe({ ...client, getBlock: async () => ({}) }, "difficultyZero"),
    ).toEqual({ supported: null, error: "invalid-response" });
    expect(
      await runFeatureProbe(
        { ...client, call: async () => ({ data: `0x${"00".repeat(32)}` }) },
        "prevrandao",
      ),
    ).toEqual({ supported: null, error: "inconclusive" });
    expect(
      await runFeatureProbe(
        { ...client, call: async () => ({ data: `0x${"11".repeat(32)}` }) },
        "prevrandao",
      ),
    ).toEqual({ supported: true });
  });

  it("validates precompile outputs exactly, not just their lengths", async () => {
    const client = baseClient();
    const call = vi.fn(async (args) => {
      expect(args.data.length).toBe(322);
      return { data: `0x${"00".repeat(31)}01` as Hex };
    });
    expect(await runFeatureProbe({ ...client, call }, "rip7212")).toEqual({ supported: true });
    for (const feature of ["rip7212", "bls12381"]) {
      const bytes = feature === "rip7212" ? 32 : 128;
      expect(
        await runFeatureProbe(
          { ...client, call: async () => ({ data: `0x${"11".repeat(bytes)}` }) },
          feature,
        ),
      ).toEqual({ supported: null, error: "invalid-response" });
      expect(await runFeatureProbe({ ...client, call: async () => ({}) }, feature)).toEqual({
        supported: false,
      });
    }
  });

  it("does not infer EIP-7702 activation from simulated code or errors", async () => {
    const client = baseClient();
    expect(await runFeatureProbe(client, "eip7702")).toEqual({
      supported: null,
      error: "inconclusive",
    });
    expect(client.call).not.toHaveBeenCalled();
  });

  it("prevents a caller from mutating the global feature catalog", () => {
    const features = listKnownFeatures();
    expect(Object.isFrozen(features)).toBe(true);
    expect(Object.isFrozen(features[0])).toBe(true);
    expect(listKnownFeatures()[0]?.id).toBe("clz");
  });
});
