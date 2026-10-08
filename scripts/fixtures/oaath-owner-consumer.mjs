import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOAAthExecutionProvider, requestOAAthPlanPermission } from "@moesi/oaath";
import { createOAAth } from "@oaath/sdk";
import { createLocalOwnerAnvilFixture } from "@oaath/testing/anvil";
import { IDBFactory } from "fake-indexeddb";
import { createMoesi, MemoryDeploymentRunStore, parseDeploymentRunRecord } from "moesi";
import { createCetaneObserver } from "moesi/cetane";
import solc from "solc";
import { encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";

let stage = "owner_compile";
let fixture;
let localClient;
const validation = process.argv[2]?.startsWith("validation-")
  ? process.argv[2].slice("validation-".length)
  : undefined;
const localSession = process.argv[2] === "local-session" || validation !== undefined;
// Same adapter code; the SDK detects the account's Kernel version.
const accountVersion = process.argv[2] === "kernel-v4" ? "0.4.0" : undefined;
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
  for (const wallet of accountVersion ? ["local"] : ["browser", "local"])
    for (const bundler of localSession ? ["accept"] : ["accept", "reject"]) {
      stage = `owner_${wallet}_${bundler}_fixture`;
      fixture = await createLocalOwnerAnvilFixture({
        wallet,
        bundler,
        ...(accountVersion ? { kernelVersion: accountVersion } : {}),
        ...(validation ? { sessionValidation: validation } : {}),
      });
      if (localSession) globalThis.indexedDB = new IDBFactory();
      const open = async () => {
        if (!localSession) return fixture.openClient();
        await localClient?.close();
        localClient = createOAAth({
          account: fixture.address,
          approvals: { kind: "wallet", owner: fixture.wallet },
          chains: fixture.createChainPorts(),
          origin: "https://consumer.example",
        });
        return localClient;
      };
      const observer = createCetaneObserver({
        chains: { [fixture.chainId]: { rpcUrls: [fixture.rpcUrl] } },
      });
      const store = new MemoryDeploymentRunStore();
      const moesi = createMoesi({ observer, runStore: store });
      const manifest = {
        version: "moesi.manifest/v8",
        contracts: [
          {
            kind: "managed",
            id: "counter",
            sender: {
              kind: "smart-account",
              address: fixture.address,
              accountId: "sra-kernel-v33",
            },
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
      const account = { address: fixture.address, accountId: "sra-kernel-v33" };
      const oaath = await open();
      if (accountVersion) {
        stage = `owner_${wallet}_${bundler}_account_version`;
        const review = await oaath
          .account(fixture.address)
          .owner(fixture.wallet)
          .reviewCalls({ chain: fixture.chainId, calls: plan.steps.map((step) => step.call) });
        assert.equal(review.account.implementation, `kernel:${accountVersion}`);
      }
      if (localSession) {
        stage = `owner_${wallet}_local_permission`;
        assert.equal(
          (
            await requestOAAthPlanPermission({
              oaath,
              account,
              plans: [plan],
              perChainOperationLimit: 3,
            })
          ).status,
          "requested",
        );
      }
      const underlying = createOAAthExecutionProvider({
        oaath,
        account,
        owner: fixture.wallet,
        payer: { kind: "connected-eoa", wallet: fixture.wallet },
        signer: localSession && !validation ? "session" : "auto",
      });
      if (validation) {
        stage = `owner_${wallet}_validation_${validation}_review`;
        const executionReview = await moesi.reviewExecution({
          plan,
          provider: underlying,
          packing: "per-step",
        });
        assert.ok(fixture.sessionEstimationCount > 0);
        assert.equal(fixture.signatureCount, 1);
        assert.equal(fixture.bundlerSubmissionCount, 0);
        if (validation === "unavailable") {
          assert.equal(executionReview.provider.status, "blocked");
          assert.equal(executionReview.provider.reasons[0].code, "oaath_review_unavailable");
        } else {
          assert.equal(executionReview.provider.status, "supported");
          assert.equal(executionReview.provider.chains[0].signer, "owner");
          assert.equal(
            executionReview.provider.chains[0].signerReason,
            "session-validation-failed",
          );
          stage = `owner_${wallet}_validation_apply`;
          const run = moesi.apply({
            plan,
            provider: underlying,
            executionReview,
            observeTiming: { attempts: 2, delayMs: 0 },
          });
          const result = await run.wait();
          stage = `owner_${wallet}_validation_${result.status}`;
          assert.equal(result.status, "converged");
          stage = `owner_${wallet}_validation_signature_count`;
          assert.equal(fixture.signatureCount, 3);
          stage = `owner_${wallet}_validation_submission_count`;
          assert.equal(fixture.bundlerSubmissionCount, 2);
          assert.equal(fixture.fallbackSubmissionCount, 0);
          const saved = parseDeploymentRunRecord(
            JSON.parse(JSON.stringify(await store.get(run.runId))),
          );
          stage = `owner_${wallet}_validation_operation_count`;
          assert.equal(saved.operations.length, 2);
          assert.ok(fixture.rpcRequestCount <= 1_000);
          process.stdout.write(
            `packed_oaath_validation_${wallet}_sdk_requests_${fixture.rpcRequestCount}\n`,
          );
          stage = `owner_${wallet}_validation_recovery`;
          const recovered = createOAAthExecutionProvider({ oaath: await open(), account });
          for (const operation of saved.operations) {
            assert.equal(operation.phase, "finalized");
            const observed = await recovered.observe({ reference: operation.reference });
            assert.equal(observed.status, "finalized");
            assert.equal(observed.finalized.sender, fixture.address);
            assert.deepEqual(
              observed.finalized.calls,
              plan.steps
                .filter((step) => operation.stepIds.includes(step.id))
                .map((step) => step.call),
            );
          }
          assert.equal(
            (await moesi.plan({ chains: [fixture.chainId], manifest })).disposition,
            "converged",
          );
          assert.equal(fixture.signatureCount, 3);
          assert.equal(fixture.bundlerSubmissionCount, 2);
        }
        await localClient.close();
        localClient = undefined;
        await fixture.close();
        fixture = undefined;
        continue;
      }
      const provider = { ...underlying, observe: async () => ({ status: "pending" }) };
      stage = `owner_${wallet}_${bundler}_review`;
      const executionReview = await moesi.reviewExecution({ plan, provider });
      assert.equal(executionReview.provider.status, "supported");
      assert.equal(executionReview.packing, "per-chain");
      const chainReview = executionReview.provider.chains[0];
      assert.equal(chainReview.signer, localSession ? "session" : "owner");
      assert.equal(chainReview.sender, fixture.address);
      assert.equal(chainReview.accountId, account.accountId);
      assert.equal(
        chainReview.signerReason,
        localSession ? "session-authorized" : "plan-fits-one-operation",
      );
      if (!localSession)
        assert.equal(chainReview.fallback.condition, "conclusive_bundler_rejection");
      assert.equal(fixture.signatureCount, localSession ? 1 : 0);
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
      // Age the receipt beyond the SDK's request budget before reopening.
      const aged = await fixture.rpcFetch(
        new Request(fixture.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "anvil_mine",
            params: ["0x400", "0x0"],
          }),
        }),
      );
      assert.equal(aged.ok, true);
      assert.equal(Object.hasOwn(await aged.json(), "error"), false);
      const reopened = await open();
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
        bundler === "reject" ? "erc4337-handleops" : "erc4337-bundler",
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
      if (localSession) {
        stage = `owner_${wallet}_local_reuse`;
        const desired = structuredClone(manifest);
        const cell = desired.contracts[0].configuration[0];
        cell.expectedResult = encodeAbiParameters([{ type: "uint256" }], [43n]);
        cell.writeData = encodeFunctionData({
          abi: contract.abi,
          functionName: "setValue",
          args: [43n],
        });
        const repair = await fresh.plan({ chains: [fixture.chainId], manifest: desired });
        assert.equal(repair.steps.length, 1);
        assert.equal(
          (await requestOAAthPlanPermission({ oaath: reopened, account, plans: [repair] })).status,
          "reused",
        );
        const sessionProvider = createOAAthExecutionProvider({
          oaath: reopened,
          account,
          signer: "session",
        });
        const review = await fresh.reviewExecution({ plan: repair, provider: sessionProvider });
        assert.equal(review.provider.status, "supported");
        const changed = fresh.apply({
          plan: repair,
          provider: sessionProvider,
          executionReview: review,
          observeTiming: { attempts: 2, delayMs: 0 },
        });
        assert.equal((await changed.wait()).status, "converged");
        assert.equal(
          (await fresh.plan({ chains: [fixture.chainId], manifest: desired })).disposition,
          "converged",
        );
        assert.equal(fixture.signatureCount, 1);
        assert.equal(fixture.bundlerSubmissionCount, 2);
        stage = `owner_${wallet}_local_disconnect_resume`;
        const grant = await (await reopened.connect()).resume();
        assert.ok(grant);
        stage = `owner_${wallet}_local_disconnect_revoke`;
        assert.deepEqual((await reopened.disconnect(grant)).unfinished, []);
        stage = `owner_${wallet}_local_disconnect_signatures`;
        assert.equal(fixture.signatureCount, 2);
        stage = `owner_${wallet}_local_disconnect_submissions`;
        assert.equal(fixture.bundlerSubmissionCount, 3);
        localClient = undefined;
      }
      await fixture.close();
      fixture = undefined;
    }
} catch {
  process.stderr.write(`packed_oaath_${stage}\n`);
  process.exitCode = 1;
} finally {
  await localClient?.close();
  if (fixture) await fixture.close();
}
