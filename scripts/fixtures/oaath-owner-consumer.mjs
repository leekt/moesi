import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOAAthExecutionProvider } from "@moesi/oaath";
import { createLocalOwnerAnvilFixture } from "@oaath/testing/anvil";
import { createMoesi, MemoryDeploymentRunStore, parseDeploymentRunRecord } from "moesi";
import { createViemObserver } from "moesi/viem";
import solc from "solc";
import { encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";

let stage = "owner_compile";
let fixture;
try {
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
  assert.equal(compiled.errors?.some((e) => e.severity === "error") ?? false, false);
  const contract = compiled.contracts["Configurable.sol"].Configurable;
  for (const wallet of ["browser", "local"])
    for (const bundler of ["accept", "reject"]) {
      stage = `owner_${wallet}_${bundler}_fixture`;
      fixture = await createLocalOwnerAnvilFixture({ wallet, bundler });
      const observer = createViemObserver({
        chains: { [fixture.chainId]: { rpcUrls: [fixture.rpcUrl] } },
      });
      const store = new MemoryDeploymentRunStore();
      const moesi = createMoesi({ observer, runStore: store });
      const manifest = {
        version: "moesi.manifest/v6",
        contracts: [
          {
            kind: "managed",
            id: "counter",
            sender: { kind: "smart-account", address: fixture.address, accountId: fixture.address },
            deployment: {
              kind: "create2-factory-v1",
              requiresRuntime: [],
              salt: `0x${"ab".repeat(32)}`,
              initCode: `0x${contract.evm.bytecode.object}`,
              value: "0",
            },
            expectedRuntimeCodeHash: keccak256(`0x${contract.evm.deployedBytecode.object}`),
            checks: [],
            storageChecks: [],
            configuration: [
              {
                id: "value",
                readData: encodeFunctionData({ abi: contract.abi, functionName: "value" }),
                expectedResult: encodeAbiParameters([{ type: "uint256" }], [42n]),
                writeData: encodeFunctionData({
                  abi: contract.abi,
                  functionName: "setValue",
                  args: [42n],
                }),
                value: "0",
              },
            ],
          },
        ],
      };
      stage = `owner_${wallet}_${bundler}_plan`;
      const plan = await moesi.plan({ chains: [fixture.chainId], manifest });
      assert.equal(plan.steps.length, 2);
      const account = { kind: "existing", address: fixture.address };
      const oaath = await fixture.openClient();
      const underlying = createOAAthExecutionProvider({ oaath, account, owner: fixture.wallet });
      const provider = { ...underlying, observe: async () => ({ status: "pending" }) };
      stage = `owner_${wallet}_${bundler}_review`;
      const executionReview = await moesi.reviewExecution({ plan, provider });
      assert.equal(executionReview.provider.status, "supported");
      assert.equal(executionReview.packing, "per-chain");
      const chainReview = executionReview.provider.chains[0];
      assert.equal(chainReview.signer, "owner");
      assert.equal(chainReview.sender, fixture.address);
      assert.equal(chainReview.signerReason, "plan-fits-one-operation");
      assert.equal(chainReview.fallback.condition, "conclusive_bundler_rejection");
      assert.equal(fixture.signatureCount, 0);
      assert.equal(fixture.bundlerSubmissionCount, 0);
      stage = `owner_${wallet}_${bundler}_apply`;
      const run = moesi.apply({
        plan,
        provider,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      });
      const initial = await run.wait();
      assert.notEqual(initial.status, "converged");
      assert.equal(fixture.signatureCount, 1);
      assert.equal(fixture.bundlerSubmissionCount, 1);
      assert.equal(fixture.fallbackSubmissionCount, bundler === "reject" ? 1 : 0);
      const saved = parseDeploymentRunRecord(
        JSON.parse(JSON.stringify(await store.get(run.runId))),
      );
      assert.equal(saved.operations.length, 1);
      assert.equal(saved.operations[0].phase, "submitted");
      assert.deepEqual(saved.operations[0].stepIds, ["counter:deploy", "counter:configure:value"]);
      stage = `owner_${wallet}_${bundler}_resume`;
      const reopened = await fixture.openClient();
      const restored = new MemoryDeploymentRunStore();
      await restored.create(saved);
      const fresh = createMoesi({ observer, runStore: restored });
      const recovery = createOAAthExecutionProvider({ oaath: reopened, account });
      const resumed = await fresh.resume({
        runId: run.runId,
        provider: recovery,
        observeTiming: { attempts: 2, delayMs: 0 },
      });
      const result = await resumed.wait();
      assert.equal(result.status, "converged");
      const evidence = result.chains[0].execution.operations[0].providerEvidence;
      assert.equal(evidence.sender, fixture.address);
      assert.equal(
        evidence.submissionRoute,
        bundler === "reject" ? "entrypoint-handleops" : "bundler",
      );
      assert.deepEqual(
        evidence.calls,
        plan.steps.map((step) => step.call),
      );
      assert.equal(
        (await fresh.plan({ chains: [fixture.chainId], manifest })).disposition,
        "converged",
      );
      assert.equal(fixture.signatureCount, 1);
      assert.equal(fixture.bundlerSubmissionCount, 1);
      assert.equal(fixture.fallbackSubmissionCount, bundler === "reject" ? 1 : 0);
      await fixture.close();
      fixture = undefined;
    }
} catch {
  process.stderr.write(`packed_oaath_${stage}\n`);
  process.exitCode = 1;
} finally {
  if (fixture) await fixture.close();
}
