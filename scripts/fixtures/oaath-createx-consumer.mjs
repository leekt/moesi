import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOAAthExecutionProvider, requestOAAthPlanPermission } from "@moesi/oaath";
import { createLocalAnvilFixture } from "@oaath/testing/anvil";
import {
  CREATEX_FACTORY_V1_ADDRESS,
  createMoesi,
  deriveCreateXSenderProtectedRawSalt,
  MemoryDeploymentRunStore,
  predictManifestAddresses,
} from "moesi";
import { createViemObserver } from "moesi/viem";
import {
  concatHex,
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
} from "viem";

let stage = "createx_fixture";
let fixture;
try {
  fixture = await createLocalAnvilFixture({ chainIds: [421614, 11155111] });
  const factoryCode = (
    await readFile(new URL("./CreateX.runtime.hex", import.meta.url), "utf8")
  ).trim();
  const clients = new Map();
  for (const id of fixture.chainIds) {
    const url = fixture.rpcUrl(id);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const chain = defineChain({
      id,
      name: "local",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    });
    const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) });
    await client.request({
      method: "anvil_setCode",
      params: [CREATEX_FACTORY_V1_ADDRESS, factoryCode],
    });
    clients.set(id, client);
  }
  const oaath = await fixture.openClient();
  const connection = await oaath.connect();
  stage = "createx_permission";
  const grant = await connection.requestPermission({
    chainScope: "all",
    expiresIn: 1800,
    perChainOperationLimit: 2,
    permissions: [
      {
        calls: [
          {
            target: CREATEX_FACTORY_V1_ADDRESS,
            selectors: ["0x26307668", "0x9c36a286"],
            valueLimit: "0",
          },
        ],
      },
    ],
  });
  const account = (await grant.account(fixture.chainIds[0])).toLowerCase();
  for (const chain of fixture.chainIds)
    assert.equal((await grant.account(chain)).toLowerCase(), account);
  const initCode = "0x6002600c60003960026000f36000";
  const entropy = "0x04a9469db98e61f23775c1";
  const rawSalt = deriveCreateXSenderProtectedRawSalt({ sender: account, entropy });
  const call = {
    target: CREATEX_FACTORY_V1_ADDRESS,
    data: concatHex([
      "0x9c36a286",
      encodeAbiParameters([{ type: "bytes32" }, { type: "bytes" }], [rawSalt, initCode]),
    ]),
    value: "0",
  };
  const facts = await grant.reviewCalls({ chain: fixture.chainIds[0], calls: [call] });
  const manifest = {
    version: "moesi.manifest/v5",
    contracts: ["createx-create2-v1", "createx-create3-v1"].map((kind, index) => ({
      kind: "managed",
      id: `protected-${index}`,
      deployment: { kind, entropy, initCode, value: "0", requiresRuntime: [] },
      sender: { kind: "smart-account", accountId: facts.accountId, address: account },
      expectedRuntimeCodeHash: keccak256("0x6000"),
      configuration: [],
      checks: [],
      storageChecks: [],
      enforcement: {
        callScope: "required-onchain",
        expiry: "required",
        operationLimit: "required",
      },
    })),
  };
  const moesi = createMoesi({
    runStore: new MemoryDeploymentRunStore(),
    observer: createViemObserver({
      chains: Object.fromEntries(
        fixture.chainIds.map((id) => [id, { rpcUrls: [fixture.rpcUrl(id)] }]),
      ),
      batch: true,
    }),
  });
  stage = "createx_plan";
  const plan = await moesi.plan({ chains: fixture.chainIds, manifest });
  assert.equal(plan.disposition, "changes");
  assert.equal(plan.steps.length, 4);
  const addresses = predictManifestAddresses(manifest);
  for (const step of plan.steps) assert.equal(step.call.data.slice(10, 74), rawSalt.slice(2));
  assert.equal((await requestOAAthPlanPermission({ oaath, plan })).status, "reused");
  assert.equal(fixture.approvalCount, 1);
  const provider = createOAAthExecutionProvider({ oaath });
  stage = "createx_sender_mismatch";
  const wrong = structuredClone(manifest);
  for (const resource of wrong.contracts)
    resource.sender.address = "0x1111111111111111111111111111111111111111";
  const wrongPlan = await moesi.plan({ chains: fixture.chainIds, manifest: wrong });
  assert.equal(
    (await moesi.reviewExecution({ plan: wrongPlan, provider })).provider.status,
    "blocked",
  );
  assert.equal(fixture.submissionCount, 0);
  stage = "createx_review";
  const executionReview = await moesi.reviewExecution({ plan, provider });
  assert.equal(executionReview.provider.status, "supported");
  for (const chain of executionReview.provider.chains) assert.equal(chain.sender, account);
  stage = "createx_apply";
  const result = await moesi.apply({ plan, provider, executionReview }).wait();
  stage = "createx_apply_converged";
  assert.equal(result.status, "converged");
  stage = "createx_apply_count";
  assert.equal(fixture.submissionCount, 4);
  for (const chain of result.chains) {
    stage = "createx_apply_finalized";
    assert.equal(chain.execution.kind, "finalized");
    stage = "createx_apply_sender";
    for (const step of chain.execution.steps) assert.equal(step.providerEvidence.sender, account);
    stage = "createx_apply_code";
    for (const { address } of addresses)
      assert.equal(await clients.get(chain.chainId).getCode({ address }), "0x6000");
  }
  stage = "createx_convergence";
  assert.equal((await moesi.verify({ plan })).status, "converged");
  const next = await moesi.plan({ chains: fixture.chainIds, manifest });
  assert.equal(next.disposition, "converged");
  assert.equal(next.steps.length, 0);
  assert.equal(fixture.submissionCount, 4);
} catch {
  process.stderr.write(`packed_oaath_${stage}\n`);
  process.exitCode = 1;
} finally {
  if (fixture) await fixture.close();
}
