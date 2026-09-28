import assert from "node:assert/strict";
import { createLocalAnvilFixture } from "@oaath/testing/anvil";
import { createPublicClient, defineChain, http } from "viem";
import { run as minimal } from "./examples/minimal-oaath/main.mjs";
import { run as multichain } from "./examples/multichain-oaath/main.mjs";

let fixture;
try {
  const installed = new URL("./node_modules/", import.meta.url).href;
  for (const name of ["moesi", "@moesi/oaath", "@oaath/sdk", "@oaath/testing/anvil"])
    assert.ok(import.meta.resolve(name).startsWith(installed));
  for (const name of process.argv.slice(2)) {
    const chainIds = name === "minimal-oaath" ? [421614] : [421614, 11155111];
    fixture = await createLocalAnvilFixture({ chainIds });
    try {
      const publicClients = new Map(
        chainIds.map((id) => {
          const url = fixture.rpcUrl(id);
          assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
          const chain = defineChain({
            id,
            name: "OAAth local example",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: [url] } },
          });
          return [id, createPublicClient({ chain, transport: http(url, { retryCount: 0 }) })];
        }),
      );
      const oaath = await fixture.openClient();
      const outcome =
        name === "minimal-oaath"
          ? await minimal({ oaath, publicClient: publicClients.get(chainIds[0]) })
          : await multichain({ oaath, publicClients });
      assert.equal(outcome.authorization.status, "requested");
      assert.equal(fixture.approvalCount, 1);
      assert.equal(fixture.submissionCount, chainIds.length);
      assert.equal(outcome.plan.steps.length, chainIds.length);
      assert.equal(outcome.result.status, "converged");
      assert.equal(outcome.verification.status, "converged");
      assert.equal(outcome.verification.chains.length, chainIds.length);
      assert.equal(new Set(outcome.plan.cells.map(({ address }) => address)).size, 1);
      for (const chain of outcome.executionReview.provider.chains)
        assert.deepEqual(chain.enforcement, {
          calls: "onchain",
          expiry: "onchain",
          operationCount: "onchain",
        });
      process.stdout.write(
        `${name}: one approval, ${chainIds.length} submission(s); converged; fresh verification passed\n`,
      );
    } finally {
      await fixture.close();
      fixture = undefined;
    }
  }
} catch {
  process.stderr.write("example_oaath_failed\n");
  process.exitCode = 1;
} finally {
  if (fixture) await fixture.close();
}
