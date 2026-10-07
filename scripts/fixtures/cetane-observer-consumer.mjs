import assert from "node:assert/strict";
import { createServer } from "node:http";
import { keccak256 } from "cetane/utils";
import { createMoesi } from "moesi";
import { createCetaneObserver } from "moesi/cetane";

const address = `0x${"11".repeat(20)}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const manifest = {
  version: "moesi.manifest/v6",
  contracts: [
    {
      kind: "external",
      id: "fixture",
      address,
      expectedRuntimeCodeHash: keccak256("0x6000"),
      checks: [0, 1].map((i) => ({
        id: `read-${i}`,
        caller: address,
        readData: "0x12345678",
        expectedResult: "0x6000",
      })),
      storageChecks: [{ id: "storage", slot: hash(0), expectedWord: hash(0) }],
    },
  ],
};
const calls = [];
let failCode = false;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  const batch = Array.isArray(input) ? input : [input];
  const results = batch.map((rpc) => {
    calls.push(rpc);
    if (rpc.method === "eth_getCode" && failCode) {
      failCode = false;
      return { jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "fixture failure" } };
    }
    let result = "0x6000";
    if (rpc.method === "eth_chainId") result = "0x1";
    if (rpc.method === "eth_getStorageAt") result = hash(0);
    if (rpc.method === "eth_getBlockByNumber") {
      const tag = rpc.params[0];
      const n = { latest: 100, safe: 90, finalized: 80 }[tag] ?? Number(BigInt(tag));
      result = { number: `0x${n.toString(16)}`, hash: hash(n), parentHash: hash(n - 1) };
    }
    return { jsonrpc: "2.0", id: rpc.id, result };
  });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(Array.isArray(input) ? results : results[0]));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  for (const batch of [false, true]) {
    calls.length = 0;
    const make = () =>
      createCetaneObserver({
        chains: { 1: { rpcUrls: [url, url], pin: "finalized" } },
        batch,
        retry: { attempts: 3 },
      });
    const observer = make();
    const moesi = createMoesi({ observer });
    failCode = true;
    const plan = await moesi.plan({ manifest, chains: [1] });
    assert.equal(plan.disposition, "converged");
    assert.equal(plan.snapshots[0].blockHash, hash(80));
    const result = await moesi.verify({ plan });
    assert.equal(result.status, "converged");
    const snapshot = { chainId: 1, blockNumber: "80", blockHash: hash(80) };

    assert.equal(
      await observer.checkBlockAncestry({ chainId: 1, ancestor: snapshot, descendant: snapshot }),
      true,
    );

    for (const call of calls.filter(({ method }) =>
      ["eth_getCode", "eth_call", "eth_getStorageAt"].includes(method),
    ))
      assert.deepEqual(call.params.at(-1), { blockHash: hash(80), requireCanonical: true });
  }
  console.log(
    "packed observer: explicit finalized policy, exact canonical hashes and failover verified",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
