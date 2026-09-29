import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOAAthExecutionProvider, requestOAAthPlanPermission } from "@moesi/oaath";
import { createLocalAnvilFixture } from "@oaath/testing/anvil";
import { createMoesi, MemoryDeploymentRunStore, parseDeploymentRunRecord } from "moesi";
import { createViemObservationAdapter } from "moesi/viem";
import solc from "solc";
import {
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
} from "viem";

let stage = "fixture";
let fixture;
try {
  const installed = new URL("./node_modules/", import.meta.url).href;
  for (const name of ["moesi", "@moesi/oaath", "@oaath/sdk", "@oaath/testing/anvil"])
    assert.ok(import.meta.resolve(name).startsWith(installed));
  const accountVersion = process.argv[2] ?? "0.4.0";
  assert.ok(["0.4.0", "0.3.3"].includes(accountVersion));
  fixture = await createLocalAnvilFixture({
    chainIds: [421614, 11155111],
    kernelVersion: accountVersion,
  });
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
  stage = "compile_fixture";
  const compiled = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: {
          "Configurable.sol": {
            content: await readFile(new URL("./Configurable.sol", import.meta.url), "utf8"),
          },
        },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "shanghai",
          outputSelection: {
            "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
          },
        },
      }),
    ),
  );
  assert.equal(compiled.errors?.some((error) => error.severity === "error") ?? false, false);
  const configurable = compiled.contracts["Configurable.sol"].Configurable;
  const runtime = `0x${configurable.evm.deployedBytecode.object}`;
  const initCode = `0x${configurable.evm.bytecode.object}`;
  const oaath = await fixture.openClient();
  const account =
    accountVersion === "0.3.3"
      ? {
          address: oaath.binding.account.address,
          accountId: "heterogeneous-fleet",
        }
      : undefined;
  const accountOption = account ? { account } : {};
  stage = "plan";
  const plan = await moesi.plan({
    chains: fixture.chainIds,
    manifest: {
      version: "moesi.manifest/v6",
      contracts: [
        {
          kind: "managed",
          id: "counter",
          ...(account
            ? {
                sender: {
                  kind: "smart-account",
                  address: account.address,
                  accountId: account.accountId,
                },
              }
            : {}),
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: `0x${"ab".repeat(32)}`,
            initCode,
            value: "0",
          },
          expectedRuntimeCodeHash: keccak256(runtime),
          configuration: [
            {
              id: "value",
              readData: encodeFunctionData({ abi: configurable.abi, functionName: "value" }),
              expectedResult: encodeAbiParameters([{ type: "uint256" }], [42n]),
              writeData: encodeFunctionData({
                abi: configurable.abi,
                functionName: "setValue",
                args: [42n],
              }),
              value: "0",
            },
          ],
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
  assert.equal(plan.steps.length, 4);
  const shards = [];
  stage = "shard_plan";
  for (const [index, chainId] of fixture.chainIds.entries()) {
    const manifest = structuredClone(plan.manifest);
    const resource = manifest.contracts[0];
    resource.deployment.salt = `0x${(index === 0 ? "cd" : "ef").repeat(32)}`;
    resource.configuration[0].expectedResult = encodeAbiParameters(
      [{ type: "uint256" }],
      [44n + BigInt(index)],
    );
    resource.configuration[0].writeData = encodeFunctionData({
      abi: configurable.abi,
      functionName: "setValue",
      args: [44n + BigInt(index)],
    });
    shards.push(await moesi.plan({ chains: [chainId], manifest }));
  }
  stage = "permission";
  assert.equal(
    (
      await requestOAAthPlanPermission({
        oaath,
        ...accountOption,
        plans: [plan, ...shards],
        perChainOperationLimit: 3,
      })
    ).status,
    "requested",
  );
  assert.equal(
    (await requestOAAthPlanPermission({ oaath, ...accountOption, plans: [plan, ...shards] }))
      .status,
    "reused",
  );
  assert.equal(fixture.approvalCount, 1);
  assert.equal(fixture.submissionCount, 0);
  assert.equal(oaath.binding.account.kernelVersion, accountVersion);
  const provider = createOAAthExecutionProvider({ oaath, ...accountOption });
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
  assert.equal(executionReview.packing, "per-chain");
  for (const chain of executionReview.provider.chains) {
    assert.equal(chain.signer, "session");
    if (account) assert.equal(chain.accountId, account.accountId);
    if (accountVersion === "0.3.3") assert.equal(chain.sender, oaath.binding.account.address);
    assert.match(chain.route, /^oaath-session-erc4337-handleops:/);
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
  assert.equal(retained.operations.length, 2);
  for (const op of retained.operations)
    assert.deepEqual(op.stepIds, ["counter:deploy", "counter:configure:value"]);
  for (const step of retained.operations) assert.equal(step.phase, "submitted");
  const references = retained.operations.map((step) => step.reference);
  stage = "reopen";
  const restoredStore = new MemoryDeploymentRunStore();
  await restoredStore.create(retained);
  const fresh = createMoesi({ observer, runStore: restoredStore });
  const reopened = await fixture.openClient();
  const recoveredProvider = createOAAthExecutionProvider({ oaath: reopened, ...accountOption });
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
    final.operations.map((step) => step.reference),
    references,
  );
  for (const chain of result.chains) {
    assert.equal(chain.execution.kind, "finalized");
    assert.deepEqual(
      chain.execution.operations[0].providerEvidence.calls,
      plan.requirements.find((r) => r.chainId === chain.chainId).calls,
    );
  }
  stage = "verify";
  assert.equal((await fresh.verify({ plan })).status, "converged");
  assert.equal(fixture.submissionCount, 2);
  stage = "silent_repair";
  const desired = JSON.parse(JSON.stringify(plan.manifest));
  const row = desired.contracts[0].configuration[0];
  row.expectedResult = encodeAbiParameters([{ type: "uint256" }], [43n]);
  row.writeData = encodeFunctionData({
    abi: configurable.abi,
    functionName: "setValue",
    args: [43n],
  });
  const repair = await fresh.plan({ manifest: desired, chains: fixture.chainIds });
  assert.equal(repair.steps.length, 2);
  assert.equal(
    (await requestOAAthPlanPermission({ oaath: reopened, ...accountOption, plans: [repair] }))
      .status,
    "reused",
  );
  const repairReview = await fresh.reviewExecution({ plan: repair, provider: recoveredProvider });
  assert.equal(repairReview.provider.status, "supported");
  const repaired = await fresh
    .apply({
      plan: repair,
      provider: recoveredProvider,
      executionReview: repairReview,
      observeTiming: { attempts: 3, delayMs: 0 },
    })
    .wait();
  assert.equal(repaired.status, "converged");
  assert.equal(fixture.approvalCount, 1);
  assert.equal(fixture.submissionCount, 4);
  assert.equal((await fresh.plan({ manifest: desired, chains: fixture.chainIds })).steps.length, 0);
  stage = "heterogeneous_shards";
  for (const shard of shards) {
    const review = await fresh.reviewExecution({ plan: shard, provider: recoveredProvider });
    assert.equal(review.provider.status, "supported");
    if (account) assert.equal(review.provider.chains[0].accountId, account.accountId);
    const completed = await fresh
      .apply({
        plan: shard,
        provider: recoveredProvider,
        executionReview: review,
        observeTiming: { attempts: 3, delayMs: 0 },
      })
      .wait();
    assert.equal(completed.status, "converged");
    assert.equal((await fresh.verify({ plan: shard })).status, "converged");
  }
  assert.equal(fixture.approvalCount, 1);
  assert.equal(fixture.submissionCount, 6);
} catch {
  process.stderr.write(`packed_oaath_${stage}\n`);
  process.exitCode = 1;
} finally {
  if (fixture) await fixture.close();
}
