import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOAAthExecutionProvider, requestOAAthPlanPermission } from "@moesi/oaath";
import { createLocalAnvilFixture } from "@oaath/testing/anvil";
import { createMoesi, MemoryDeploymentRunStore, parseDeploymentRunRecord } from "moesi";
import { createCetaneObservationAdapter } from "moesi/cetane";
import solc from "solc";
import {
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
} from "viem";

// A receipt-unknown run on one caller-reserved lane does not block the next run on
// another lane, and the held run resumes from its reference without resubmission.
let stage = "fixture";
let fixture;
try {
  let inner;
  let holdNext = false;
  let held;
  let sdkOpens = 0;
  fixture = await createLocalAnvilFixture({
    chainIds: [421614],
    submission: (open) => {
      inner = open;
      return async (request) => {
        sdkOpens += 1;
        if (!holdNext) return open(request);
        holdNext = false;
        held = request;
        return {
          async send() {
            throw new Error("held");
          },
          async close() {},
        };
      };
    },
  });
  const chainId = fixture.chainIds[0];
  const url = fixture.rpcUrl(chainId);
  const chain = defineChain({
    id: chainId,
    name: "local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) });
  const observer = createCetaneObservationAdapter({
    publicClientForChain: (id) => (id === chainId ? client : undefined),
  });
  const store = new MemoryDeploymentRunStore();
  const moesi = createMoesi({ observer, runStore: store });
  stage = "compile";
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
  const manifest = (index) => ({
    version: "moesi.manifest/v8",
    contracts: [
      {
        kind: "managed",
        id: "counter",
        deployment: {
          kind: "create2-factory-v1",
          requiresRuntime: [],
          // One shared four-byte prefix keeps every deploy under one permission selector.
          salt: `0x${"ab".repeat(31)}${index.toString(16).padStart(2, "0")}`,
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
      },
    ],
  });
  stage = "plan";
  const plans = [];
  for (const index of [0, 1, 2])
    plans.push(await moesi.plan({ chains: [chainId], manifest: manifest(index) }));
  const oaath = await fixture.openClient();
  stage = "permission";
  assert.equal((await requestOAAthPlanPermission({ oaath, plans })).status, "requested");
  const apply = async (plan, provider, attempts) => {
    const executionReview = await moesi.reviewExecution({ plan, provider });
    assert.equal(executionReview.provider.status, "supported");
    const run = moesi.apply({
      plan,
      provider,
      executionReview,
      observeTiming: { attempts, delayMs: 100 },
    });
    return { run, result: await run.wait() };
  };

  // A lane never installs the permission; the default lane does it first.
  stage = "default_lane";
  const install = await apply(plans[0], createOAAthExecutionProvider({ oaath }), 5);
  assert.equal(install.result.status, "converged");

  stage = "held_lane";
  holdNext = true;
  const laneA = { id: "run_a", nonceKey: 1n };
  const first = await apply(plans[1], createOAAthExecutionProvider({ oaath, lane: laneA }), 1);
  assert.notEqual(first.result.status, "converged");
  assert.ok(held && inner, "lane 1 submission was not held");
  const retained = parseDeploymentRunRecord(
    JSON.parse(JSON.stringify(await store.get(first.run.runId))),
  );
  assert.equal(retained.operations.length, 1);
  assert.match(
    retained.operations[0].reference.reference,
    /^oaath-op-v3:session:[0-9a-f]{64}:lane\.1\.run_a:/,
  );

  stage = "independent_lane";
  const laneB = { id: "run_b", nonceKey: 2n };
  const second = await apply(plans[2], createOAAthExecutionProvider({ oaath, lane: laneB }), 5);
  assert.equal(second.result.status, "converged");
  assert.equal(sdkOpens, 3);

  stage = "release";
  const release = await inner(held);
  await release.send();

  stage = "resume";
  const restoredStore = new MemoryDeploymentRunStore();
  await restoredStore.create(retained);
  const fresh = createMoesi({ observer, runStore: restoredStore });
  const reopened = await fixture.openClient();
  // Recovery needs no lane configuration: the reference names it.
  const resumed = await fresh.resume({
    runId: first.run.runId,
    provider: createOAAthExecutionProvider({ oaath: reopened }),
    observeTiming: { attempts: 5, delayMs: 100 },
  });
  assert.equal((await resumed.wait()).status, "converged");
  assert.equal(sdkOpens, 3);
  assert.equal(fixture.submissionCount, 3);

  stage = "verify";
  for (const index of [0, 1, 2])
    assert.equal(
      (await fresh.plan({ chains: [chainId], manifest: manifest(index) })).disposition,
      "converged",
    );
} catch {
  process.stderr.write(`packed_oaath_lanes_${stage}\n`);
  process.exitCode = 1;
} finally {
  if (fixture) await fixture.close();
}
