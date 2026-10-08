import { getCreate2Address, keccak256 } from "cetane/utils";
import { CREATE2_FACTORY_V1_ADDRESS, type MoesiManifest } from "moesi";
import type { FleetBaseline } from "moesi/fleet";
import { describe, expect, it, vi } from "vitest";
import { type CliIo, runCli } from "../src/command.js";

const HASH = `0x${"aa".repeat(32)}` as const;
const CODE = "0x6000";
const ADDRESS = getCreate2Address({
  from: CREATE2_FACTORY_V1_ADDRESS,
  salt: HASH,
  bytecodeHash: keccak256(CODE),
}).toLowerCase() as `0x${string}`;
const manifest: MoesiManifest = {
  version: "moesi.manifest/v8",
  contracts: [
    {
      kind: "managed",
      id: "book",
      deployment: {
        kind: "create2-factory-v1",
        salt: HASH,
        initCode: CODE,
        value: "0",
        requiresRuntime: [],
      },
      expectedRuntimeCodeHash: keccak256(CODE),
      checks: [],
      storageChecks: [],
      configuration: [
        {
          id: "value",
          readData: "0x11111111",
          expectedResult: "0x01",
          writeData: "0x22222222",
          value: "0",
        },
      ],
    },
  ],
};
const baseline: FleetBaseline = {
  version: "moesi.fleet-baseline/v2",
  cells: [
    {
      chainId: 1,
      resourceId: "book",
      kind: "managed",
      address: ADDRESS,
      expectedRuntimeCodeHash: keccak256(CODE),
      checks: [],
      storageChecks: [],
      configuration: [
        {
          id: "old-value",
          caller: "0x0000000000000000000000000000000000000000",
          readData: "0x11111111",
          expectedResult: "0x01",
          after: [],
        },
      ],
    },
  ],
};
const args = [
  "check-parity",
  "--manifest",
  "manifest.json",
  "--baseline",
  "baseline.json",
  "--chain",
  "1=http://local.invalid",
];
function fixture() {
  const files = new Map([
    ["manifest.json", JSON.stringify(manifest)],
    ["baseline.json", JSON.stringify(baseline)],
  ]);
  const output: string[] = [];
  const errors: string[] = [];
  const state = { badCall: false };
  const fetch: CliIo["fetch"] = vi.fn(async (_url, init) => {
    const { id, method } = JSON.parse(String(init?.body));
    const result =
      method === "eth_chainId"
        ? "0x1"
        : method === "eth_getBlockByNumber"
          ? { number: "0xa", hash: HASH }
          : method === "eth_getCode"
            ? CODE
            : method === "eth_call"
              ? state.badCall
                ? null
                : "0x01"
              : undefined;
    if (result === undefined) throw new Error("unexpected RPC");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  const io: CliIo = {
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    fetch,
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("private path details");
      return value;
    },
    readEnv: vi.fn(() => {
      throw new Error("must not load credentials");
    }),
    createRunStore: vi.fn(() => {
      throw new Error("must not open run store");
    }),
    createCetaneRuntime: vi.fn(() => {
      throw new Error("must not create execution provider");
    }),
    createOAAthRuntime: vi.fn(async () => {
      throw new Error("must not open OAAth");
    }),
  };
  return { io, state, files, output, errors };
}

describe("check-parity command", () => {
  it("returns current pinned JSON evidence without loading execution capabilities", async () => {
    const { io, output, errors } = fixture();
    expect(await runCli([...args, "--json"], io)).toBe(0);
    const result = JSON.parse(output[0]!);
    expect(result).toMatchObject({
      version: "moesi.fleet-parity/v2",
      status: "match",
      chains: [
        {
          chainId: 1,
          snapshot: { blockNumber: "10", blockHash: HASH },
          candidatePlan: { disposition: "converged" },
          cells: [{ differences: [] }],
        },
      ],
    });
    expect(io.readEnv).not.toHaveBeenCalled();
    expect(io.createRunStore).not.toHaveBeenCalled();
    expect(io.createCetaneRuntime).not.toHaveBeenCalled();
    expect(io.createOAAthRuntime).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
  it("renders actual and expected values for migration differences", async () => {
    const { io, output, files } = fixture();
    files.set(
      "baseline.json",
      JSON.stringify({
        ...baseline,
        cells: baseline.cells.map((cell) => ({
          ...cell,
          configuration: cell.configuration.map((row) => ({ ...row, expectedResult: "0x02" })),
        })),
      }),
    );
    expect(await runCli(args, io)).toBe(2);
    expect(output[0]).toContain("Moesi fleet parity different");
    expect(output[0]).toContain("expected_result_mismatch");
    expect(output[0]).toContain(
      "baseline-expected=0x02 candidate-expected=0x01 baseline-observed=0x01 candidate-observed=0x01",
    );
  });
  it("returns exit 3 rather than parity when RPC results are unreadable", async () => {
    const { io, output, state } = fixture();
    state.badCall = true;
    expect(await runCli([...args, "--json"], io)).toBe(3);
    expect(JSON.parse(output[0]!).status).toBe("unreadable");
  });
  it.each([
    ["not JSON", "fleet_baseline_json_invalid"],
    [JSON.stringify({ version: "moesi.fleet-baseline/v0" }), "unsupported_fleet_baseline_version"],
    [JSON.stringify({ ...baseline, secret: "never render me" }), "invalid_fleet_baseline"],
    [
      JSON.stringify({
        ...baseline,
        cells: baseline.cells.map((cell) => ({ ...cell, chainId: 2 })),
      }),
      "baseline_chain_missing",
    ],
  ])("rejects invalid baseline artifacts before RPC", async (source, code) => {
    const { io, errors, files } = fixture();
    files.set("baseline.json", source);
    expect(await runCli([...args, "--json"], io)).toBe(1);
    expect(JSON.parse(errors[0]!).error.code).toBe(code);
    expect(errors.join("")).not.toContain("never render me");
    expect(io.fetch).not.toHaveBeenCalled();
  });
  it("keeps file errors bounded and rejects missing baselines and signing flags", async () => {
    const { io, errors, files } = fixture();
    files.delete("baseline.json");
    expect(await runCli(args, io)).toBe(1);
    expect(errors[0]).toContain("fleet_baseline_read_failed");
    expect(errors.join("")).not.toContain("private path details");
    expect(
      await runCli(
        ["check-parity", "--manifest", "manifest.json", "--chain", "1=http://local.invalid"],
        io,
      ),
    ).toBe(1);
    expect(await runCli([...args, "--signer", "1=KEY"], io)).toBe(1);
    expect(io.fetch).not.toHaveBeenCalled();
  });
});
