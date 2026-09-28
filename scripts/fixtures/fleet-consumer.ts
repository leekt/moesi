import { createMoesi } from "moesi";
import { defineFleet, type FleetContext } from "moesi/fleet";
import { encodeAbiParameters, keccak256, parseAbi } from "viem";

const abi = parseAbi([
  "function setTargetTokens(uint256[] chains, address[] sources, address[] targets, uint8[] decimals)",
  "function checkTargetToken(uint256 chain, address source, address target) view returns (uint8)",
  "function decimals() view returns (uint8)",
]);
const address = "0x1111111111111111111111111111111111111111";
const hash = `0x${"aa".repeat(32)}` as const;
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
  "packed fleet: typed ABI surface, literal compilation, pinned reads and convergence verified",
);
