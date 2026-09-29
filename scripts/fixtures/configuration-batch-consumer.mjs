import assert from "node:assert/strict";
import { createMoesi, parseReviewedPlan } from "moesi";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem";

const abi = parseAbi([
  "function setTargetTokens(uint256[] chains, address[] sources, address[] targets, uint8[] decimals)",
  "function checkTargetToken(uint256 chain, address source, address target) view returns (uint8)",
]);
const source = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const hash = `0x${"aa".repeat(32)}`;
let pending = true;
const manifest = {
  version: "moesi.manifest/v6",
  contracts: [
    {
      kind: "managed",
      id: "book",
      deployment: {
        kind: "create2-factory-v1",
        salt: hash,
        initCode: "0x6000",
        value: "0",
        requiresRuntime: [],
      },
      expectedRuntimeCodeHash: keccak256("0x6000"),
      checks: [],
      storageChecks: [],
      configuration: Array.from({ length: 143 }, (_, index) => ({
        id: `route-${index}`,
        readData: encodeFunctionData({
          abi,
          functionName: "checkTargetToken",
          args: [BigInt(index), source, target],
        }),
        expectedResult: encodeAbiParameters([{ type: "uint8" }], [6]),
        writeData: encodeFunctionData({
          abi,
          functionName: "setTargetTokens",
          args: [[BigInt(index)], [source], [target], [6]],
        }),
        value: "0",
        batch: {
          key: "routes",
          parameters: ["uint256[]", "address[]", "address[]", "uint8[]"],
          maxRows: 64,
        },
        after: [{ chainId: 2, address: target, expectedRuntimeCodeHash: keccak256("0x6000") }],
      })),
    },
  ],
};
const moesi = createMoesi({
  observer: {
    async captureSnapshot() {
      return { blockNumber: "10", blockHash: hash };
    },
    async readCode({ chainId }) {
      return chainId === 2 && pending ? "0x" : "0x6000";
    },
    async readCall({ data }) {
      const { args } = decodeFunctionData({ abi, data });
      return encodeAbiParameters(
        [{ type: "uint8" }],
        [args[0] === 0n || args[0] === 142n ? 18 : 6],
      );
    },
    async checkBlockAncestry() {
      return true;
    },
  },
});
const waiting = await moesi.plan({ manifest, chains: [1] });
assert.equal(waiting.disposition, "pending");
assert.equal(waiting.steps.length, 0);
assert.equal(waiting.peers.length, 1);
assert.equal(waiting.cells[0].configuration[0].readiness, "pending-peer");
pending = false;
const ready = await moesi.plan({ manifest, chains: [1] });
assert.deepEqual(
  ready.steps.map(({ configurationIds }) => configurationIds),
  [["route-0", "route-142"]],
);
assert.deepEqual(decodeFunctionData({ abi, data: ready.steps[0].call.data }).args[0], [0n, 142n]);
assert.equal(ready.steps[0].postconditions.length, 2);
assert.deepEqual(parseReviewedPlan(JSON.parse(JSON.stringify(ready))), ready);
console.log("packed configuration batches: pending peers and drift-only route writes verified");
