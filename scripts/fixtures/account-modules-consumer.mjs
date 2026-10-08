import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPublicClient, http } from "cetane";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from "cetane/utils";
import {
  createMoesi,
  MemoryDeploymentRunStore,
  parseDeploymentRunRecord,
  parseReviewedPlan,
} from "moesi";
import { createCetaneObserver } from "moesi/cetane";

let stage = "startup";
async function main() {
  const url = process.env.MOESI_PACKED_ANVIL_RPC;
  assert(url?.startsWith("http://127.0.0.1:"));
  for (const path of ["moesi", "moesi/cetane", "cetane/observation/modules"])
    assert(import.meta.resolve(path).startsWith(new URL("./node_modules/", import.meta.url).href));
  const fixtures = JSON.parse(
    await readFile(new URL("./account-modules-fixtures.json", import.meta.url), "utf8"),
  );
  const transport = http(url);
  const rpc = transport.request;
  const chainId = Number(BigInt(await rpc({ method: "eth_chainId" })));
  const reader = createPublicClient({ chain: { id: chainId, name: "Module proof" }, transport });
  const [admin] = await rpc({ method: "eth_accounts" });
  async function send(from, to, data) {
    const hash = await rpc({
      method: "eth_sendTransaction",
      params: [{ from, ...(to ? { to } : {}), data, gas: "0xe4e1c0" }],
    });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return {
      hash,
      receipt,
      raw: await rpc({ method: "eth_getTransactionReceipt", params: [hash] }),
    };
  }
  async function deploy(name, args = "0x") {
    return (await send(admin, null, `${fixtures[name].bytecode}${args.slice(2)}`)).raw
      .contractAddress;
  }
  stage = "deploy";
  const entry = await deploy("EntryPoint");
  const implementation = await deploy(
    "KernelUUPS",
    encodeAbiParameters([{ type: "address" }], [entry]),
  );
  const immutable = await deploy(
    "KernelImmutableECDSA",
    encodeAbiParameters([{ type: "address" }], [entry]),
  );
  const factory = await deploy(
    "KernelFactory",
    encodeAbiParameters([{ type: "address" }, { type: "address" }], [implementation, immutable]),
  );
  const validator = await deploy("ECDSAValidator");
  const extraValidator = await deploy("ECDSAValidator");
  const executor = await deploy("MockExecutor");
  const signer = await deploy("MockSigner");
  stage = "account";
  const packages = [{ moduleType: 1n, module: validator, moduleData: admin, internalData: "0x" }];
  const account = (
    await reader.readContract({
      address: factory,
      abi: fixtures["KernelFactory"].abi,
      functionName: "getAddress",
      args: [packages, 0n],
    })
  ).toLowerCase();
  const deployed = await send(
    admin,
    factory,
    encodeFunctionData({
      abi: fixtures["KernelFactory"].abi,
      functionName: "deploy",
      args: [packages, 0n],
    }),
  );
  // The test-only provider impersonates the account; no claim about signing or OAAth enforcement.
  await rpc({ method: "anvil_impersonateAccount", params: [account] });
  await rpc({ method: "anvil_setBalance", params: [account, "0x8ac7230489e80000"] });
  const management = parseAbi([
    "function installModule(uint256,address,bytes)",
    "function uninstallModule(uint256,address,bytes)",
  ]);
  const wrap = (moduleData, context) =>
    encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [moduleData, context]);
  const call = (functionName, type, module, moduleData = "0x", context = "0x") =>
    encodeFunctionData({
      abi: management,
      functionName,
      args: [type, module, wrap(moduleData, context)],
    });
  stage = "install";
  await send(account, account, call("installModule", 2n, executor));
  await rpc({ method: "anvil_mine", params: ["0x3"] });
  let counts = 0,
    splits = 0;
  let hideContext = false;
  const observer = createCetaneObserver({
    chains: { [chainId]: { rpcUrls: [url] } },
    retry: { attempts: 1 },
    admitRpc: ({ methods }) => {
      counts += methods.length;
      return counts <= 600;
    },
    fetchFn: async (input, init) => {
      const body = JSON.parse(init.body);
      if (
        body.method === "eth_getLogs" &&
        BigInt(body.params[0].toBlock) - BigInt(body.params[0].fromBlock) > 1n
      ) {
        splits++;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32005, message: "log range limit" },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      const response = await fetch(input, init);
      if (hideContext && body.method === "eth_getTransactionByHash") {
        const payload = await response.json();
        if (payload.result) payload.result.input = "0x";
        return Response.json(payload);
      }
      return response;
    },
  });
  const store = new MemoryDeploymentRunStore();
  const client = createMoesi({ observer, runStore: store });
  const entries = [
    { kind: "root", id: `0x01${validator.slice(2)}` },
    { kind: "validator", address: validator },
  ];
  const manifest = {
    version: "moesi.manifest/v8",
    contracts: [
      {
        kind: "external",
        id: "treasury",
        address: account,
        expectedRuntimeCodeHash: keccak256(await reader.getCode({ address: account })),
        checks: [],
        storageChecks: [],
        semanticChecks: [],
        accountModules: {
          profile: "kernel-0.4.0",
          fromBlock: deployed.receipt.blockNumber.toString(),
          entries,
          accountId: "treasury",
          removals: [{ key: `executor:${executor}`, data: call("uninstallModule", 2n, executor) }],
        },
      },
    ],
  };
  stage = "plan";
  const plan = parseReviewedPlan(
    JSON.parse(JSON.stringify(await client.plan({ manifest, chains: [chainId] }))),
  );
  stage = "disposition";
  assert.equal(plan.disposition, "changes");
  stage = "step";
  assert.equal(plan.steps[0].kind, "remove-module");
  stage = "complete";
  assert.equal(plan.cells[0].accountModules.inventory.complete, true);
  stage = "splits";
  assert(splits > 0);
  let sends = 0;
  const provider = {
    id: "anvil-module-proof",
    async review() {
      return {
        providerId: this.id,
        status: "supported",
        reasons: [],
        chains: [
          {
            chainId,
            sender: account,
            accountId: "treasury",
            route: "anvil-impersonation",
            signer: "owner",
            signerReason: "local-fixture",
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
    async prepare({ plan }) {
      return { providerId: this.id, planId: plan.planId, binding: plan.steps };
    },
    async submit({ prepared, action }) {
      assert(prepared.binding.some((step) => JSON.stringify(step) === JSON.stringify(action.step)));
      sends++;
      const submitted = await send(account, action.step.call.target, action.step.call.data);
      return { providerId: this.id, chainId, reference: submitted.hash };
    },
    async observe({ reference }) {
      const receipt = await reader.waitForTransactionReceipt({ hash: reference.reference });
      const transaction = await rpc({
        method: "eth_getTransactionByHash",
        params: [reference.reference],
      });
      assert.equal(receipt.status, "success");
      return {
        status: "finalized",
        finalized: {
          submissionRoute: "anvil-impersonation",
          chainId,
          sender: transaction.from,
          calls: [
            {
              target: transaction.to,
              data: transaction.input,
              value: BigInt(transaction.value).toString(),
            },
          ],
          providerEvidenceId: transaction.hash,
          blockNumber: receipt.blockNumber.toString(),
          blockHash: receipt.blockHash,
        },
      };
    },
  };
  stage = "review";
  const executionReview = await client.reviewExecution({ plan, provider });
  stage = "apply";
  const run = client.apply({
    plan,
    provider,
    executionReview,
    observeTiming: { attempts: 2, delayMs: 1 },
  });
  const result = await run.wait();
  stage = [
    "result",
    result.status,
    result.chains[0]?.execution.reason ?? "none",
    result.chains[0]?.cells[0]?.status.reason ?? "none",
  ].join("-");
  assert.equal(result.status, "converged");
  assert.equal(sends, 1);
  stage = "record";
  parseDeploymentRunRecord(await store.get(run.runId));
  assert.equal((await client.verify({ plan })).status, "converged");
  stage = "mutate";
  // Fresh authority mutations are found even though the reviewed plan has not changed.
  await send(account, account, call("installModule", 1n, extraValidator, admin));
  await send(account, account, call("installModule", 6n, signer, "0x", "0xaabbccdd"));
  stage = "verify";
  const changed = await client.verify({ plan });
  assert.equal(changed.status, "drifted");
  const evidence = changed.chains[0].cells[0].accountModules;
  assert(evidence.differences.some(({ key }) => key === `validator:${extraValidator}`));
  assert(evidence.differences.some(({ key }) => key === "permission:0xaabbccdd"));
  assert.equal(evidence.inventory.complete, true);
  assert.equal(evidence.inventory.reason, null);
  assert(evidence.inventory.history.counts.length > 0);
  stage = "declared-context-convergence";
  counts = 0;
  const updatedManifest = structuredClone(manifest);
  updatedManifest.contracts[0].accountModules.entries.push(
    { kind: "validator", address: extraValidator },
    { kind: "permission", id: "0xaabbccdd", signer, policies: [] },
  );
  const updatedPlan = await client.plan({ manifest: updatedManifest, chains: [chainId] });
  assert.equal(updatedPlan.steps.length, 0);
  assert.equal(updatedPlan.cells[0].accountModules.inventory.complete, true);
  assert.equal((await client.verify({ plan: updatedPlan })).status, "converged");
  stage = "unknown-context";
  counts = 0;
  hideContext = true;
  // A positive install count without discoverable or declared context stays incomplete.
  const hidden = await client.verify({ plan });
  assert.notEqual(hidden.status, "converged");
  assert.equal(hidden.chains[0].cells[0].accountModules.inventory.complete, false);
  assert.equal(hidden.chains[0].cells[0].accountModules.inventory.reason, "unknown-context");
}
try {
  await main();
} catch {
  process.stderr.write(`module_consumer_failed_${stage}\n`);
  process.exitCode = 1;
}
