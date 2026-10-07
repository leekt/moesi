import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createMoesi, MemoryDeploymentRunStore, parseDeploymentRunRecord } from "moesi";
import { keccak256 } from "viem";

const recovering = process.argv[2] === "recover";
const hash = (byte) => `0x${byte.repeat(64)}`;
const sender = `0x${"ab".repeat(20)}`;
const factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const factoryCode =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
const code = "0x6000";

for (const scenario of ["untouched", "partial", "atomic"]) {
  const store = new MemoryDeploymentRunStore();
  const observer = {
    async captureSnapshot() {
      return { blockNumber: recovering ? "102" : "100", blockHash: hash(recovering ? "c" : "a") };
    },
    async readCode({ address }) {
      return address === factory ? factoryCode : recovering ? code : "0x";
    },
    async readCall() {
      return "0x";
    },
    async checkBlockAncestry() {
      return true;
    },
  };
  const client = createMoesi({ observer, runStore: store });
  const saved = recovering
    ? parseDeploymentRunRecord(JSON.parse(await readFile(`${scenario}.json`, "utf8")))
    : null;
  const plan =
    saved?.plan ??
    (await client.plan({
      chains: [1],
      manifest: {
        version: "moesi.manifest/v7",
        contracts: ["1", "2"].map((byte) => ({
          kind: "managed",
          id: `contract-${byte}`,
          deployment: {
            kind: "create2-factory-v1",
            salt: hash(byte),
            initCode: "0x6002600c60003960026000f36000",
            value: "0",
            requiresRuntime: [],
          },
          expectedRuntimeCodeHash: keccak256(code),
          checks: [],
          storageChecks: [],
          configuration: [],
          sender: { kind: "owner-eoa", address: sender },
        })),
      },
    }));
  let submissions = 0,
    observations = 0;
  const reference = { providerId: "fixture", chainId: 1, reference: hash("8") };
  const submit = async () => {
    assert.equal(recovering, false, "recovery submitted an operation");
    submissions++;
    return reference;
  };
  const provider = {
    id: "fixture",
    async review() {
      assert.equal(recovering, false, "recovery reviewed pending work");
      return {
        providerId: "fixture",
        status: "supported",
        reasons: [],
        chains: [
          {
            chainId: 1,
            sender,
            accountId: null,
            route: "fixture",
            signer: "owner",
            signerReason: "caller-supplied-eoa",
            fallback: null,
            enforcement: {
              calls: "interactive-owner",
              expiry: "not-enforced",
              operationCount: "not-enforced",
            },
          },
        ],
      };
    },
    async prepare() {
      assert.equal(recovering, false, "recovery prepared pending work");
      return { providerId: "fixture", planId: plan.planId, binding: {} };
    },
    submit,
    ...(scenario === "atomic" ? { submitBatch: submit } : {}),
    async observe(input) {
      observations++;
      assert.deepEqual(input.reference, reference);
      return recovering
        ? {
            status: "finalized",
            finalized: {
              chainId: 1,
              sender,
              calls: (scenario === "atomic" ? plan.steps : plan.steps.slice(0, 1)).map(
                (step) => step.call,
              ),
              providerEvidenceId: hash("9"),
              submissionRoute: "fixture",
              blockNumber: "101",
              blockHash: hash("b"),
            },
          }
        : { status: "pending" };
    },
  };
  if (!recovering) {
    const executionReview = await client.reviewExecution({ plan, provider });
    const run = client.apply({
      plan,
      provider,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });
    if (scenario === "untouched") run.requestStop();
    await run.wait();
    assert.equal(submissions, scenario === "untouched" ? 0 : 1);
    await writeFile(`${scenario}.json`, JSON.stringify(await store.get(run.runId)), { flag: "wx" });
    continue;
  }
  await store.create(saved);
  const run = await client.resume({ runId: saved.runId, provider, mode: "observe-only" });
  const result = await run.wait();
  const next = parseDeploymentRunRecord(await store.get(run.runId));
  assert.equal(result.version, "moesi.run-result/v8");
  assert.equal(submissions, 0);
  assert.equal(observations, scenario === "untouched" ? 0 : 1);
  if (scenario === "atomic") {
    assert.equal(result.status, "converged");
    assert.equal(run.state, "complete");
  } else {
    assert.equal(result.chains[0].execution.reason, "pending-execution");
    assert.equal(run.state, "recovery-required");
    assert.deepEqual(next.operations[1], saved.operations[1]);
    if (scenario === "untouched") assert.deepEqual(next, saved);
  }
  if (scenario !== "untouched") {
    assert.equal(next.operations[0].phase, "finalized");
    assert.deepEqual(next.operations[0].reference, saved.operations[0].reference);
  }
}

if (recovering)
  console.log(
    "packed observe-only recovery: fresh process, retained references, pending work preserved, zero submissions",
  );
