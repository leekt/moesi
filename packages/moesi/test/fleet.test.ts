import {
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  parseAbi,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { defineFleet, type FleetContext } from "../src/fleet/index.js";
import { CREATE2_FACTORY_V1_ADDRESS, createMoesi, MoesiObservationError } from "../src/index.js";
import { testAddress, testHash } from "./fixtures.js";

const ABI = parseAbi([
  "function setTargetTokens(uint256[] chains, address[] sources, address[] targets, uint8[] decimals)",
  "function checkTargetToken(uint256 chain, address source, address target) view returns (uint8)",
  "function decimals() view returns (uint8)",
]);
const RESOURCE = {
  kind: "managed" as const,
  deployment: {
    kind: "create2-factory-v1" as const,
    salt: testHash("a"),
    initCode: "0x6000" as const,
    value: "0",
    requiresRuntime: [],
  },
  expectedRuntimeCodeHash: keccak256("0x6000"),
};
const contracts = { Book: { abi: ABI, resource: RESOURCE } } as const;
const accounts = {
  deployment: { kind: "smart-account", accountId: "fleet:kernel", address: testAddress("a") },
} as const;

describe("typed literal fleet authoring", () => {
  it("compiles a selected source without configuring its read-only peers", async () => {
    const configured: number[] = [];
    const fleet = defineFleet({
      chains: [1, 2, 3],
      contracts,
      configure(chain, ctx) {
        configured.push(chain);
        if (chain !== 1) throw new Error("unselected source must not run");
        return {
          Book: [
            ctx.contract("Book").rule({
              id: "selected",
              read: {
                functionName: "checkTargetToken",
                args: [2n, testAddress("a"), testAddress("b")],
              },
              expect: 6,
              write: {
                functionName: "setTargetTokens",
                args: [[2n], [testAddress("a")], [testAddress("b")], [6]],
              },
              after: [ctx.deployedOn(2, "Book")],
            }),
          ],
        };
      },
    });
    const groups = await fleet.compile({ chains: [1] });
    expect(configured).toEqual([1]);
    expect(groups.map((group) => group.chains)).toEqual([[1]]);
    const resource = groups[0]!.manifest.contracts[0]!;
    expect(resource.kind === "managed" && resource.configuration[0]!.after?.[0]?.chainId).toBe(2);
    for (const chains of [[], [1, 1], [4], [NaN], [1.5]])
      await expect(fleet.compile({ chains })).rejects.toMatchObject({ code: "invalid_fleet" });
    expect(configured).toEqual([1]);
  });
  it("omits chains where every resource is excluded", async () => {
    const groups = await defineFleet({
      chains: [1, 2],
      contracts: {
        Book: { abi: ABI, resource: (chain) => (chain === 2 ? RESOURCE : null) },
      },
    }).compile();
    expect(groups.map((group) => group.chains)).toEqual([[2]]);
  });
  it("groups equal manifests deterministically and caps each plan at 32 chains", async () => {
    const groups = await defineFleet({
      chains: Array.from({ length: 65 }, (_, i) => 65 - i),
      contracts,
    }).compile();
    expect(groups.map(({ chains }) => chains.length)).toEqual([32, 32, 1]);
    expect(groups.flatMap(({ chains }) => chains)).toEqual(
      Array.from({ length: 65 }, (_, i) => i + 1),
    );
    expect(groups[0]!.manifest).toEqual(groups[2]!.manifest);
    expect(Object.isFrozen(groups[0]!.manifest.contracts)).toBe(true);
    expect(JSON.parse(JSON.stringify(groups))).toEqual(groups);
  });

  it("expands 22 per-chain route matrices with pending peers and only drifted batch rows", async () => {
    const chains = Array.from({ length: 22 }, (_, i) => i + 1);
    const fleet = defineFleet({
      chains,
      contracts,
      accounts,
      configure(chain, ctx) {
        const book = ctx.contract("Book");
        return {
          Book: Array.from({ length: 143 }, (_, i) =>
            book.rule({
              id: `route-${i}`,
              read: {
                functionName: "checkTargetToken",
                args: [BigInt(i + 100), ctx.account("deployment").address, book.address],
              },
              expect: chain === 1 ? 18 : 6,
              write: {
                functionName: "setTargetTokens",
                args: [
                  [BigInt(i + 100)],
                  [ctx.account("deployment").address],
                  [ctx.address("Book")],
                  [chain === 1 ? 18 : 6],
                ],
              },
              batch: { key: "routes", maxRows: 64 },
              after: [ctx.deployedOn(chain === 22 ? 1 : chain + 1, "Book")],
            }),
          ),
        };
      },
    });
    const groups = await fleet.compile();
    expect(groups).toHaveLength(22);
    expect(
      groups.every(
        ({ manifest }) =>
          manifest.contracts[0]!.kind === "managed" &&
          manifest.contracts[0]!.configuration.length === 143,
      ),
    ).toBe(true);
    const moesi = createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "10", blockHash: testHash("a") };
        },
        async readCode({ chainId }) {
          return chainId === 2 ? "0x" : "0x6000";
        },
        async readCall() {
          return encodeAbiParameters([{ type: "uint8" }], [6]);
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    });
    const plan = await moesi.plan(groups[0]!);
    expect(plan.disposition).toBe("pending");
    expect(plan.steps).toEqual([]);
    expect(plan.peers[0]!.chainId).toBe(2);
    expect(plan.cells[0]!.configuration.every((row) => row.readiness === "pending-peer")).toBe(
      true,
    );
  });

  it("resolves account and lazy resource constructor references and per-chain resource exclusions", async () => {
    const ctor = parseAbi(["constructor(address handler, address owner)"]);
    const groups = await defineFleet({
      chains: [1, 2],
      accounts,
      contracts: {
        Factory: {
          abi: ctor,
          resource: (chain, ctx) =>
            chain === 2
              ? null
              : {
                  ...RESOURCE,
                  deployment: {
                    ...RESOURCE.deployment,
                    salt: testHash("b"),
                    requiresRuntime: ["Handler"],
                    initCode: encodeDeployData({
                      abi: ctor,
                      bytecode: "0x6001",
                      args: [ctx.address("Handler"), ctx.account("deployment").address],
                    }),
                  },
                },
        },
        Handler: {
          abi: ABI,
          resource: (_chain, ctx) => ({ ...RESOURCE, sender: ctx.account("deployment") }),
        },
      },
      configure(_chain, ctx) {
        if (ctx.has("Factory")) expect(ctx.address("Factory")).not.toBe(ctx.address("Handler"));
        return {};
      },
    }).compile();
    expect(groups.map((group) => group.manifest.contracts.map(({ id }) => id))).toEqual([
      ["Factory", "Handler"],
      ["Handler"],
    ]);
    const predicted = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: RESOURCE.deployment.salt,
      bytecode: RESOURCE.deployment.initCode,
    }).toLowerCase();
    const factory = groups[0]!.manifest.contracts[0]!;
    expect(factory.kind === "managed" && factory.deployment.initCode).toBe(
      encodeDeployData({
        abi: ctor,
        bytecode: "0x6001",
        args: [predicted as `0x${string}`, accounts.deployment.address],
      }),
    );
  });

  it("pins and deduplicates live cross-chain reads and bakes decoded values into literal calldata", async () => {
    const captureSnapshot = vi.fn(async () => ({ blockNumber: "12", blockHash: testHash("b") }));
    const readCall = vi.fn(async () => encodeAbiParameters([{ type: "uint8" }], [18]));
    const observer = {
      captureSnapshot,
      readCall,
      async readCode() {
        return "0x6000";
      },
      async checkBlockAncestry() {
        return true;
      },
    };
    const fleet = defineFleet({
      chains: [1, 3],
      contracts,
      async configure(_chain, ctx) {
        const decimals = await ctx.read({
          chainId: 2,
          address: testAddress("b"),
          caller: testAddress("0"),
          abi: ABI,
          functionName: "decimals",
          args: [],
        });
        return {
          Book: [
            ctx.contract("Book").rule({
              id: "row",
              read: {
                functionName: "checkTargetToken",
                args: [2n, testAddress("a"), testAddress("b")],
              },
              expect: decimals,
              write: {
                functionName: "setTargetTokens",
                args: [[2n], [testAddress("a")], [testAddress("b")], [decimals]],
              },
            }),
          ],
        };
      },
    });
    await expect(fleet.compile()).rejects.toMatchObject({ code: "observer_required" });
    const groups = await fleet.compile({ observer });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.chains).toEqual([1, 3]);
    expect(captureSnapshot).toHaveBeenCalledExactlyOnceWith(2);
    expect(readCall).toHaveBeenCalledTimes(1);
    expect(readCall.mock.calls[0]).toEqual([
      expect.objectContaining({
        chainId: 2,
        target: testAddress("b"),
        caller: testAddress("0"),
        snapshot: { chainId: 2, blockNumber: "12", blockHash: testHash("b") },
      }),
    ]);
    expect(groups[0]!.reads).toMatchObject([
      {
        chainId: 2,
        result: encodeAbiParameters([{ type: "uint8" }], [18]),
        snapshot: { blockNumber: "12" },
      },
    ]);
    expect(Object.isFrozen(groups[0]!.reads[0]!.snapshot)).toBe(true);
  });

  it("supports the real fleet's parallel asset and struct-array fee writes", async () => {
    const abi = parseAbi([
      "function setAssetFeeConfigs(address[] assets, (uint256 threshold,uint16 belowBps,uint16 aboveOrEqualBps,bool isSet)[] fees)",
      "function assetFeeConfigs(address) view returns ((uint256 threshold,uint16 belowBps,uint16 aboveOrEqualBps,bool isSet))",
    ]);
    const fee = { threshold: 123n, belowBps: 1, aboveOrEqualBps: 2, isSet: true };
    const [group] = await defineFleet({
      chains: [1],
      contracts: { Fees: { abi, resource: RESOURCE } },
      configure(_chain, ctx) {
        return {
          Fees: [testAddress("a"), testAddress("b")].map((asset, index) =>
            ctx.contract("Fees").rule({
              id: `fee-${index}`,
              read: { functionName: "assetFeeConfigs", args: [asset] },
              expect: fee,
              write: { functionName: "setAssetFeeConfigs", args: [[asset], [fee]] },
              batch: { key: "fees" },
            }),
          ),
        };
      },
    }).compile();
    const plan = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "1", blockHash: testHash("a") };
        },
        async readCode() {
          return "0x6000";
        },
        async readCall() {
          return "0x";
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    }).plan(group!);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.call.data).toBe(
      encodeFunctionData({
        abi,
        functionName: "setAssetFeeConfigs",
        args: [
          [testAddress("a"), testAddress("b")],
          [fee, fee],
        ],
      }),
    );
  });

  it("retains bounded live-read causes, rejects malformed return data and propagates cancellation", async () => {
    const fleet = defineFleet({
      chains: [1],
      contracts,
      async configure(_chain, ctx) {
        await ctx.read({
          chainId: 2,
          address: testAddress("a"),
          caller: testAddress("0"),
          abi: ABI,
          functionName: "decimals",
          args: [],
        });
        return {};
      },
    });
    const cause = {
      attempts: [{ endpoint: 0, category: "timeout" as const, rpcCode: null, httpStatus: null }],
    };
    const observer = {
      async captureSnapshot() {
        return { blockNumber: "1", blockHash: testHash("a") };
      },
      async readCode() {
        return "0x6000";
      },
      async readCall() {
        throw new MoesiObservationError("observation_failed", cause);
      },
      async checkBlockAncestry() {
        return true;
      },
    };
    await expect(fleet.compile({ observer })).rejects.toMatchObject({
      code: "live_read_failed",
      cause,
    });
    await expect(
      fleet.compile({
        observer: {
          ...observer,
          async readCall() {
            throw new Error("private RPC detail");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "live_read_failed", cause: null });
    await expect(
      fleet.compile({
        observer: {
          ...observer,
          async readCall() {
            return "0x01";
          },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_live_read" });
    const abort = new AbortController();
    let start!: () => void;
    let finish!: (value: string) => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const result = fleet.compile({
      signal: abort.signal,
      observer: {
        ...observer,
        readCall(request) {
          expect(request.signal).toBe(abort.signal);
          start();
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    await started;
    abort.abort("private abort reason");
    await expect(result).rejects.toMatchObject({ code: "observation_aborted" });
    finish(encodeAbiParameters([{ type: "uint8" }], [18]));
  });

  it("rejects cycles, duplicate chains and unavailable resource references with bounded errors", async () => {
    await expect(defineFleet({ chains: [1, 1], contracts }).compile()).rejects.toMatchObject({
      code: "invalid_fleet",
    });
    await expect(
      defineFleet({
        chains: [1],
        contracts: {
          Book: {
            abi: ABI,
            resource: (_chain, ctx) => {
              ctx.address("Book");
              return RESOURCE;
            },
          },
        },
      }).compile(),
    ).rejects.toMatchObject({ code: "resource_dependency_cycle" });
    await expect(
      defineFleet({
        chains: [1],
        contracts,
        configure(_chain, ctx) {
          ctx.deployedOn(2, "Book");
          return {};
        },
      }).compile(),
    ).rejects.toMatchObject({ code: "resource_unavailable" });
    await expect(
      defineFleet({
        chains: [1],
        contracts,
        configure() {
          throw new Error("private callback detail");
        },
      }).compile(),
    ).rejects.toThrow("fleet compilation failed: authoring_failed");
  });
});

function staticTypeChecks(ctx: FleetContext<typeof contracts, typeof accounts>) {
  // @ts-expect-error Unknown resource names do not compile.
  ctx.address("Unknown");
  // @ts-expect-error Unknown account names do not compile.
  ctx.account("unknown");
  ctx.contract("Book").rule({
    id: "row",
    read: { functionName: "decimals", args: [] },
    // @ts-expect-error uint8 outputs require numbers, not strings.
    expect: "18",
    write: {
      functionName: "setTargetTokens",
      args: [[2n], [testAddress("a")], [testAddress("b")], [6]],
    },
  });
}
void staticTypeChecks;
