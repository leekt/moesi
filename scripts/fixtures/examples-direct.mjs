import assert from "node:assert/strict";
import { http as cetaneHttp, createRpcWalletClient } from "cetane";
import { createPublicClient, defineChain, http } from "viem";
import { run as repair } from "./examples/drift-repair/main.mjs";
import { run as minimal } from "./examples/minimal-cetane/main.mjs";

try {
  assert.throws(() => import.meta.resolve("@oaath/sdk"));
  assert.throws(() => import.meta.resolve("@moesi/oaath"));
  const installed = new URL("./node_modules/", import.meta.url).href;
  for (const name of ["moesi", "moesi/cetane", "cetane", "viem"])
    assert.ok(import.meta.resolve(name).startsWith(installed));
  const rpcUrl = process.env.MOESI_EXAMPLE_RPC;
  assert.match(rpcUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const chain = defineChain({
    id: 31340,
    name: "Moesi example",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0 }) });
  const accounts = await publicClient.request({ method: "eth_accounts" });
  const walletClient = createRpcWalletClient({
    chain,
    account: accounts[0],
    transport: cetaneHttp(rpcUrl),
  });
  for (const name of process.argv.slice(2)) {
    const nonce = await publicClient.getTransactionCount({ address: accounts[0] });
    const outcome = await (name === "minimal-cetane" ? minimal : repair)({
      publicClient,
      walletClient,
    });
    assert.equal(outcome.result.status, "converged");
    assert.equal(outcome.verification.status, "converged");
    assert.equal(outcome.plan.steps.length, 1);
    assert.equal(
      await publicClient.getTransactionCount({ address: accounts[0] }),
      nonce + (name === "minimal-cetane" ? 1 : 4),
    );
    assert.equal(outcome.executionReview.provider.chains[0].enforcement.calls, "interactive-owner");
    if (name === "drift-repair") {
      assert.equal(outcome.drift.status, "drifted");
      assert.notEqual(outcome.initialReview.planId, outcome.executionReview.planId);
      assert.deepEqual(outcome.plan.steps[0].configurationIds, ["value"]);
    }
    process.stdout.write(`${name}: converged; fresh verification passed\n`);
  }
} catch {
  process.stderr.write("example_direct_failed\n");
  process.exitCode = 1;
}
