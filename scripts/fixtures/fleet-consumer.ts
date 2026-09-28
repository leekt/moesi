import { CREATE2_FACTORY_V1_ADDRESS, createMoesi } from "moesi";
import { checkFleetParity, defineFleet, type FleetContext, parseFleetBaseline } from "moesi/fleet";
import { createViemObserver } from "moesi/viem";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  parseAbi,
} from "viem";

const abi = parseAbi([
  "function setTargetTokens(uint256[] chains, address[] sources, address[] targets, uint8[] decimals)",
  "function checkTargetToken(uint256 chain, address source, address target) view returns (uint8)",
  "function decimals() view returns (uint8)",
]);
const address = "0x1111111111111111111111111111111111111111";
const hash = `0x${"aa".repeat(32)}` as const;
const pool = createViemObserver({
  chains: { 1: { rpcUrls: ["https://unused.invalid"], pin: { lagBlocks: 2 } } },
  retry: { attempts: 2, rateLimitDelayMs: 20 },
  fetchFn: async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "eth_chainId" ? "0x1" : "0x6000",
      }),
    );
  },
});
if (
  (await pool.readCode({
    chainId: 1,
    address,
    snapshot: { chainId: 1, blockNumber: "1", blockHash: hash },
  })) !== "0x6000"
)
  throw new Error("packed observer public configuration failed");
const contracts = {
  Book: {
    abi,
    resource: {
      kind: "managed",
      deployment: {
        kind: "create2-factory-v1",
        salt: hash,
        initCode: "0x6000",
        value: "0",
        requiresRuntime: [],
      },
      expectedRuntimeCodeHash: keccak256("0x6000"),
    },
  },
} as const;
const observer = {
  async captureSnapshot() {
    return { blockNumber: "1", blockHash: hash };
  },
  async readCode() {
    return "0x6000";
  },
  async readCall() {
    return encodeAbiParameters([{ type: "uint8" }], [18]);
  },
  async checkBlockAncestry() {
    return true;
  },
};
const fleet = defineFleet({
  chains: [1, 2],
  contracts,
  async configure(_chain, ctx) {
    const decimals: number = await ctx.read({
      chainId: 2,
      address,
      caller: address,
      abi,
      functionName: "decimals",
      args: [],
    });
    return {
      Book: [
        ctx.contract("Book").rule({
          id: "route",
          read: { functionName: "checkTargetToken", args: [2n, address, address] },
          expect: decimals,
          write: {
            functionName: "setTargetTokens",
            args: [[2n], [address], [address], [decimals]],
          },
          batch: { key: "routes" },
          after: [ctx.deployedOn(2, "Book")],
        }),
      ],
    };
  },
});
const groups = await fleet.compile({ observer });
if (groups.length !== 1 || groups[0]!.reads.length !== 1)
  throw new Error("fleet grouping or pin deduplication failed");
const plans = await Promise.all(groups.map((group) => createMoesi({ observer }).plan(group)));
if (plans.some((plan) => plan.disposition !== "converged"))
  throw new Error("compiled fleet did not converge");
const bookAddress = getCreate2Address({
  from: CREATE2_FACTORY_V1_ADDRESS,
  salt: hash,
  bytecode: "0x6000",
});
const baseline = parseFleetBaseline({
  version: "moesi.fleet-baseline/v1",
  cells: [1, 2].map((chainId) => ({
    chainId,
    resourceId: "Book",
    kind: "managed",
    address: bookAddress,
    expectedRuntimeCodeHash: keccak256("0x6000"),
    checks: [],
    storageChecks: [],
    configuration: [
      {
        id: "original-route-label",
        caller: "0x0000000000000000000000000000000000000000",
        readData: encodeFunctionData({
          abi,
          functionName: "checkTargetToken",
          args: [2n, address, address],
        }),
        expectedResult: encodeAbiParameters([{ type: "uint8" }], [18]),
        after: [{ chainId: 2, address: bookAddress, expectedRuntimeCodeHash: keccak256("0x6000") }],
      },
    ],
  })),
});
const parity = await checkFleetParity({ ...groups[0]!, baseline, observer });
if (parity.status !== "match" || parity.chains.length !== 2 || !Object.isFrozen(parity))
  throw new Error("packed fleet parity did not retain immutable matching evidence");
function types(ctx: FleetContext<typeof contracts, Record<never, never>>) {
  ctx.contract("Book").rule({
    id: "bad",
    // @ts-expect-error The packed ABI constrains function arguments.
    read: { functionName: "decimals", args: [12] },
    expect: 6,
    write: { functionName: "setTargetTokens", args: [[], [], [], []] },
  });
  // @ts-expect-error The packed fleet preserves resource names.
  ctx.address("Unknown");
}
void types;
console.log(
  "packed fleet: typed ABI surface, literal compilation, pinned reads, parity and convergence verified",
);
