import assert from "node:assert/strict";
import { createOAAthExecutionProvider, requestOAAthPlanPermission } from "@moesi/oaath";
import { createLocalAnvilFixture } from "@oaath/testing/anvil";
import { createMoesi, MemoryDeploymentRunStore, parseDeploymentRunRecord } from "moesi";
import { createViemObservationAdapter } from "moesi/viem";
import { createPublicClient, defineChain, http, keccak256 } from "viem";

let stage = "fixture";
let fixture;
try {
  const installed = new URL("./node_modules/", import.meta.url).href;
  for (const name of ["moesi", "@moesi/oaath", "@oaath/sdk", "@oaath/testing/anvil"])
    assert.ok(import.meta.resolve(name).startsWith(installed));
  fixture = await createLocalAnvilFixture({ chainIds: [421614, 11155111] });
  const clients = new Map(
    fixture.chainIds.map((id) => {
      const url = fixture.rpcUrl(id);
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const chain = defineChain({
        id,
        name: "local",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [url] } },
      });
      return [id, createPublicClient({ chain, transport: http(url, { retryCount: 0 }) })];
    }),
  );
  const observer = createViemObservationAdapter({ publicClientForChain: (id) => clients.get(id) });
  const store = new MemoryDeploymentRunStore();
  const moesi = createMoesi({ observer, runStore: store });
  stage = "plan";
  const plan = await moesi.plan({
    chains: fixture.chainIds,
    manifest: {
      version: "moesi.manifest/v4",
      contracts: [
        {
          kind: "managed",
          id: "counter",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: `0x${"ab".repeat(32)}`,
            initCode: "0x6002600c60003960026000f36000",
            value: "0",
          },
          expectedRuntimeCodeHash: keccak256("0x6000"),
          configuration: [],
          checks: [],
          storageChecks: [],
          enforcement: {
            callScope: "required-onchain",
            expiry: "required",
            operationLimit: "required",
          },
        },
      ],
    },
  });
  assert.equal(plan.disposition, "changes");
  assert.equal(plan.steps.length, 2);
  const oaath = await fixture.openClient();
  stage = "permission";
  assert.equal((await requestOAAthPlanPermission({ oaath, plan })).status, "requested");
  assert.equal((await requestOAAthPlanPermission({ oaath, plan })).status, "reused");
  assert.equal(fixture.approvalCount, 1);
  assert.equal(fixture.submissionCount, 0);
  const provider = createOAAthExecutionProvider({ oaath });
  // Stop observation at the provider boundary after Moesi has durably retained
  // each real SDK operation reference. This is a consumer crash-window fixture.
  const unresolvedProvider = Object.freeze({
    ...provider,
    async observe() {
      return { status: "pending" };
    },
  });
  stage = "review";
  const executionReview = await moesi.reviewExecution({ plan, provider: unresolvedProvider });
  assert.equal(executionReview.provider.status, "supported");
  for (const chain of executionReview.provider.chains) {
    assert.match(chain.route, /^oaath-session-entrypoint-handleops:/);
    assert.deepEqual(chain.enforcement, {
      calls: "onchain",
      expiry: "onchain",
      operationCount: "onchain",
    });
  }
  assert.equal(fixture.submissionCount, 0);
  stage = "apply";
  const run = moesi.apply({
    plan,
    provider: unresolvedProvider,
    executionReview,
    observeTiming: { attempts: 1, delayMs: 0 },
  });
  const first = await run.wait();
  assert.notEqual(first.status, "converged");
  assert.equal(fixture.submissionCount, 2);
  const retained = parseDeploymentRunRecord(JSON.parse(JSON.stringify(await store.get(run.runId))));
  assert.equal(retained.steps.length, 2);
  for (const step of retained.steps) assert.equal(step.phase, "submitted");
  const references = retained.steps.map((step) => step.reference);
  stage = "reopen";
  const restoredStore = new MemoryDeploymentRunStore();
  await restoredStore.create(retained);
  const fresh = createMoesi({ observer, runStore: restoredStore });
  const reopened = await fixture.openClient();
  const recoveredProvider = createOAAthExecutionProvider({ oaath: reopened });
  stage = "resume";
  const recovered = await fresh.resume({
    runId: run.runId,
    provider: recoveredProvider,
    observeTiming: { attempts: 1, delayMs: 0 },
  });
  const result = await recovered.wait();
  assert.equal(result.status, "converged");
  assert.equal(fixture.submissionCount, 2);
  assert.equal(fixture.approvalCount, 1);
  const final = parseDeploymentRunRecord(await restoredStore.get(run.runId));
  assert.deepEqual(
    final.steps.map((step) => step.reference),
    references,
  );
  for (const chain of result.chains) {
    assert.equal(chain.execution.kind, "finalized");
    assert.deepEqual(
      chain.execution.steps[0].providerEvidence.calls,
      plan.requirements.find((r) => r.chainId === chain.chainId).calls,
    );
  }
  stage = "verify";
  assert.equal((await fresh.verify({ plan })).status, "converged");
  assert.equal(fixture.submissionCount, 2);
} catch {
  process.stderr.write(`packed_oaath_${stage}\n`);
  process.exitCode = 1;
} finally {
  if (fixture) await fixture.close();
}
