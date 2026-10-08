import assert from "node:assert/strict";
import { createPublicClient, http } from "cetane";
import { keccak256 } from "cetane/utils";
import { createMoesi, parseReviewedPlan } from "moesi";
import { createCetaneObserver } from "moesi/cetane";

const url = process.env.MOESI_PACKED_ANVIL_RPC;
assert(url?.startsWith("http://127.0.0.1:"));
const transport = http(url);
const rpc = transport.request;
const chainId = Number(BigInt(await rpc({ method: "eth_chainId" })));
const reader = createPublicClient({ chain: { id: chainId, name: "Minimum proof" }, transport });
const [admin, monitored] = await rpc({ method: "eth_accounts" });
// Minimal local balance reader: ABI address argument -> BALANCE -> ABI uint256.
const runtime = "0x6004353160005260206000f3";
const hash = await rpc({
  method: "eth_sendTransaction",
  params: [{ from: admin, data: `0x600c600c600039600c6000f3${runtime.slice(2)}`, gas: "0x30d40" }],
});
await reader.waitForTransactionReceipt({ hash });
const { contractAddress } = await rpc({ method: "eth_getTransactionReceipt", params: [hash] });
const manifest = {
  version: "moesi.manifest/v8",
  contracts: [
    {
      kind: "external",
      id: "balance-reader",
      address: contractAddress,
      expectedRuntimeCodeHash: keccak256(runtime),
      checks: [],
      storageChecks: [],
      semanticChecks: [
        {
          kind: "uint256-minimum",
          id: "executor-balance",
          caller: admin,
          readData: `0x4d2301cc${monitored.slice(2).padStart(64, "0")}`,
          minimum: "100",
        },
      ],
    },
  ],
};
const client = createMoesi({
  observer: createCetaneObserver({
    chains: { [chainId]: { rpcUrls: [url] } },
    retry: { attempts: 1 },
  }),
});
await rpc({ method: "anvil_setBalance", params: [monitored, "0x65"] });
await rpc({ method: "anvil_mine", params: ["0x1"] });
const plan = parseReviewedPlan(
  JSON.parse(JSON.stringify(await client.plan({ manifest, chains: [chainId] }))),
);
assert.equal(plan.disposition, "converged");
assert.deepEqual(plan.steps, []);
for (const [balance, status] of [
  ["0x64", "converged"],
  ["0x63", "drifted"],
]) {
  await rpc({ method: "anvil_setBalance", params: [monitored, balance] });
  await rpc({ method: "anvil_mine", params: ["0x1"] });
  assert.equal((await client.verify({ plan })).status, status);
}
const drift = await client.plan({ manifest, chains: [chainId] });
assert.equal(drift.disposition, "blocked");
assert.deepEqual(drift.steps, []);
assert.deepEqual(drift.requirements, []);
