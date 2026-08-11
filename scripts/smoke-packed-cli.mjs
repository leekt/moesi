import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "moesi-packed-cli-"));

try {
  const moesiTarball = await pack(join(root, "packages/moesi"));
  const cliTarball = await pack(join(root, "packages/cli"));
  const moesiSpec = `file:${join(temporary, moesiTarball)}`;
  const cliSpec = `file:${join(temporary, cliTarball)}`;
  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "moesi-packed-cli-status-smoke",
        private: true,
        type: "module",
        dependencies: { moesi: moesiSpec, "@moesi/cli": cliSpec },
      },
      null,
      2,
    )}\n`,
  );
  // pnpm pack resolves workspace:* to the package version. This workspace-level
  // override keeps the offline consumer on the exact core tarball.
  await writeFile(
    join(consumer, "pnpm-workspace.yaml"),
    `overrides:\n  moesi: ${JSON.stringify(moesiSpec)}\n`,
  );
  run("pnpm", ["install", "--offline", "--ignore-scripts"], consumer);

  const installedCore = JSON.parse(
    await readFile(join(consumer, "node_modules", "moesi", "package.json"), "utf8"),
  );
  const installedCli = JSON.parse(
    await readFile(join(consumer, "node_modules", "@moesi", "cli", "package.json"), "utf8"),
  );
  if (
    installedCore.name !== "moesi" ||
    installedCli.name !== "@moesi/cli" ||
    installedCli.dependencies?.moesi !== installedCore.version ||
    typeof installedCli.dependencies?.viem !== "string"
  ) {
    throw new Error("packed CLI is not bound to the exact packed core version");
  }

  const { createMoesi, MemoryDeploymentRunStore, parseDeploymentRunRecord } = await import(
    new URL("../packages/moesi/dist/index.js", import.meta.url)
  );
  const hash = (byte) => `0x${byte.repeat(64)}`;
  const address = (byte) => `0x${byte.repeat(40)}`;
  const create2Factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
  const create2FactoryRuntime =
    "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
  const resourceRuntime = "0x6000";
  const resourceRuntimeHash = "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d";
  const externalAddress = address("e");
  const externalCaller = address("a");
  const externalReadData = "0x5c975abb";
  const externalExpectedResult = "0x01";
  const externalDriftResult = "0x00";
  const externalStorageSlot = hash("4");
  const externalExpectedWord = hash("5");
  const externalDriftWord = hash("6");
  const memory = new MemoryDeploymentRunStore();
  const revisions = [];
  const runStore = {
    async get(runId) {
      return memory.get(runId);
    },
    async create(record) {
      await memory.create(record);
      revisions.push(parseDeploymentRunRecord(JSON.parse(JSON.stringify(record))));
    },
    async save(record, options) {
      await memory.save(record, options);
      revisions.push(parseDeploymentRunRecord(JSON.parse(JSON.stringify(record))));
    },
  };
  const observer = {
    async captureSnapshot() {
      return { blockNumber: "100", blockHash: hash("1") };
    },
    async readCode({ address: target }) {
      return target === create2Factory ? create2FactoryRuntime : "0x";
    },
    async readCall() {
      return "0x";
    },
    async checkBlockAncestry() {
      return true;
    },
  };
  const client = createMoesi({ observer, runStore });
  const plan = await client.plan({
    chains: [1],
    manifest: {
      version: "moesi.manifest/v1",
      contracts: [
        {
          kind: "managed",
          id: "counter",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: hash("c"),
            initCode: "0x60006000",
            value: "0",
          },
          expectedRuntimeCodeHash: resourceRuntimeHash,
          checks: [],
          storageChecks: [],
          configuration: [],
        },
      ],
    },
  });
  if (plan.capabilities?.[0]?.status?.kind !== "available") {
    throw new Error("packed seed plan did not retain canonical factory capability evidence");
  }
  const providerId = "packed-status-provider";
  const provider = Object.freeze({
    id: providerId,
    async review() {
      return {
        providerId,
        status: "supported",
        chains: [
          {
            chainId: 1,
            sender: address("b"),
            accountId: null,
            route: "packed-status",
            enforcement: {
              calls: "interactive-owner",
              expiry: "not-enforced",
              operationCount: "not-enforced",
            },
          },
        ],
        reasons: [],
      };
    },
    async prepare() {
      return { providerId, planId: plan.planId, binding: {} };
    },
    async submit({ action }) {
      return { providerId, chainId: action.chainId, reference: hash("8") };
    },
    async observe() {
      return { status: "pending" };
    },
  });
  const executionReview = await client.reviewExecution({ plan, provider });
  const deploymentRun = client.apply({
    plan,
    provider,
    executionReview,
    observeTiming: { attempts: 1, delayMs: 0 },
  });
  await deploymentRun.wait();
  if (deploymentRun.state !== "recovery-required" || revisions.length !== 3) {
    throw new Error("packed seed run did not retain contiguous submitted state");
  }

  const storeDirectory = join(consumer, "run-store");
  await mkdir(storeDirectory, { mode: 0o700 });
  for (const record of revisions) {
    await writeFile(
      join(storeDirectory, `${record.runId}.${String(record.revision).padStart(16, "0")}.json`),
      `${JSON.stringify(record)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  const before = await readdir(storeDirectory);
  const result = spawnSync(
    "pnpm",
    ["exec", "moesi", "status", "--run", deploymentRun.runId, "--store", storeDirectory, "--json"],
    { cwd: consumer, encoding: "utf8", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error("packed CLI status command failed");
  }
  const output = JSON.parse(result.stdout);
  if (
    output.version !== "moesi.cli-status/v1" ||
    output.run?.runId !== deploymentRun.runId ||
    output.run?.planId !== plan.planId ||
    output.run?.providerId !== providerId ||
    output.run?.revision !== 2 ||
    output.run?.executionState !== "recovery-required" ||
    output.run?.convergence !== "not-recorded" ||
    output.run?.steps?.[0]?.phase !== "submitted" ||
    output.run?.steps?.[0]?.reference?.reference !== hash("8")
  ) {
    throw new Error("packed CLI status projection is invalid");
  }
  if (JSON.stringify(await readdir(storeDirectory)) !== JSON.stringify(before)) {
    throw new Error("packed CLI status mutated its run store");
  }

  const planPath = join(consumer, "review-plan.json");
  const rawPlanPath = join(consumer, "raw-plan.json");
  const reviewStoreDirectory = join(consumer, "review-runs");
  await writeFile(planPath, `${JSON.stringify({ version: "moesi.cli-plan/v1", plan })}\n`);
  await writeFile(rawPlanPath, `${JSON.stringify(plan)}\n`);
  const rpcMethods = [];
  const rpcCodeTargets = [];
  const rpcCallParams = [];
  const rpcStorageParams = [];
  let externalCallMode = "satisfied";
  let externalStorageMode = "satisfied";
  const rpcServer = createServer(async (request, response) => {
    let source = "";
    for await (const chunk of request) source += chunk;
    const value = JSON.parse(source);
    rpcMethods.push(value.method);
    let result;
    let rpcError;
    if (value.method === "eth_chainId") {
      result = "0x1";
    } else if (value.method === "eth_getBlockByNumber") {
      result = { number: "0x65", hash: hash("2"), parentHash: hash("1") };
    } else if (value.method === "eth_getBlockByHash") {
      result =
        value.params?.[0] === hash("2")
          ? { number: "0x65", hash: hash("2"), parentHash: hash("1") }
          : { number: "0x64", hash: hash("1"), parentHash: hash("0") };
    } else if (value.method === "eth_getCode") {
      const target = value.params?.[0]?.toLowerCase();
      rpcCodeTargets.push(target);
      result =
        target === plan.cells[0]?.address || target === externalAddress ? resourceRuntime : "0x";
    } else if (value.method === "eth_getStorageAt") {
      rpcStorageParams.push(value.params);
      if (externalStorageMode === "unreadable") {
        rpcError = { code: -32000, message: "secret packed external storage failure" };
      } else {
        result = externalStorageMode === "drifted" ? externalDriftWord : externalExpectedWord;
      }
    } else if (value.method === "eth_call") {
      rpcCallParams.push(value.params);
      if (externalCallMode === "unreadable") {
        rpcError = { code: -32000, message: "secret packed external check failure" };
      } else {
        result = externalCallMode === "drifted" ? externalDriftResult : externalExpectedResult;
      }
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: value.id,
        ...(rpcError !== undefined
          ? { error: rpcError }
          : result === undefined
            ? { error: { code: -32601, message: "method unavailable" } }
            : { result }),
      }),
    );
  });
  await new Promise((resolve, reject) => {
    rpcServer.once("error", reject);
    rpcServer.listen(0, "127.0.0.1", resolve);
  });
  const rpcAddress = rpcServer.address();
  if (typeof rpcAddress !== "object" || rpcAddress === null) {
    throw new Error("packed CLI review server did not bind");
  }
  const rpcSecret = "packed-rpc-secret";
  const rpcUrl = `http://127.0.0.1:${rpcAddress.port}/?token=${rpcSecret}`;
  const privateKey = `0x01${randomBytes(31).toString("hex")}`;
  const reviewArguments = [
    "exec",
    "moesi",
    "apply",
    "--plan",
    planPath,
    "--provider",
    "viem",
    "--chain",
    `1=${rpcUrl}`,
    "--signer",
    "1=MOESI_PACKED_PRIVATE_KEY",
    "--confirmations",
    "2",
    "--store",
    reviewStoreDirectory,
    "--json",
  ];
  const reviewEnvironment = { ...process.env, MOESI_PACKED_PRIVATE_KEY: privateKey };
  try {
    const inspectSecret = "packed-inspect-secret";
    const planBeforeInspect = await readFile(planPath, "utf8");
    const storeBeforeInspect = await Promise.all(
      [...before]
        .sort()
        .map(async (filename) => [
          filename,
          await readFile(join(storeDirectory, filename), "utf8"),
        ]),
    );
    const consumerBeforeInspect = await snapshotWorkingTree(consumer);
    const inspectArguments = ["exec", "moesi", "inspect", "--plan", planPath, "--json"];
    if (
      ["--chain", "--provider", "--signer", "--confirmations", "--store"].some((flag) =>
        inspectArguments.includes(flag),
      )
    ) {
      throw new Error("packed CLI inspection unexpectedly requires runtime authority");
    }
    const inspectEnvironment = {
      ...process.env,
      MOESI_PACKED_PRIVATE_KEY: inspectSecret,
      MOESI_PACKED_RPC_URL: rpcUrl,
      MOESI_PACKED_RUN_STORE: inspectSecret,
    };
    const inspectJsonResult = await runCaptured(
      "pnpm",
      inspectArguments,
      consumer,
      inspectEnvironment,
    );
    if (
      inspectJsonResult.status !== 0 ||
      inspectJsonResult.stderr !== "" ||
      inspectJsonResult.stdout !== planBeforeInspect
    ) {
      throw new Error("packed CLI JSON inspection did not round-trip the canonical plan");
    }
    const inspectHumanResult = await runCaptured(
      "pnpm",
      inspectArguments.filter((argument) => argument !== "--json"),
      consumer,
      inspectEnvironment,
    );
    const inspectedStep = plan.steps[0];
    const inspectedStepIndex = inspectedStep === undefined ? -1 : plan.steps.indexOf(inspectedStep);
    const inspectedRequirement = plan.requirements[0];
    const inspectedPostcondition = inspectedStep?.postconditions[0];
    if (
      inspectedStep === undefined ||
      inspectedRequirement === undefined ||
      inspectedRequirement.sender.kind !== "sender-independent" ||
      inspectedPostcondition?.kind !== "runtime-code-hash"
    ) {
      throw new Error("packed CLI inspection fixture lacks exact review anchors");
    }
    const inspectionAnchors = [
      `Moesi reviewed plan ${plan.planId}`,
      `manifest contract counter deployment kind=create2-factory-v1 salt=${hash("c")} initCode=0x60006000 value=0`,
      `capability 1 create2-factory-v1 address=${create2Factory} expectedRuntimeCodeHash=${plan.capabilities[0]?.expectedRuntimeCodeHash} status=available`,
      `cell 1 counter address=${plan.cells[0]?.address} expectedRuntimeCodeHash=${resourceRuntimeHash} status=missing kind=managed deployment=scheduled requires-runtime=none`,
      `step 1 ${inspectedStep.id} index=${inspectedStepIndex} call target=${inspectedStep.call.target} data=${inspectedStep.call.data} value=${inspectedStep.call.value}`,
      `step 1 ${inspectedStep.id} index=${inspectedStepIndex} sender kind=sender-independent`,
      `step 1 ${inspectedStep.id} index=${inspectedStepIndex} postcondition 0 kind=runtime-code-hash address=${inspectedPostcondition.address} expectedHash=${inspectedPostcondition.expectedHash}`,
      "requirement 1 sender kind=sender-independent",
      `requirement 1 call 0 target=${inspectedRequirement.calls[0]?.target} data=${inspectedRequirement.calls[0]?.data} value=${inspectedRequirement.calls[0]?.value}`,
      `requirement 1 postcondition 0 kind=runtime-code-hash address=${inspectedPostcondition.address} expectedHash=${inspectedPostcondition.expectedHash}`,
    ];
    if (
      inspectHumanResult.status !== 0 ||
      inspectHumanResult.stderr !== "" ||
      inspectionAnchors.some((anchor) => !inspectHumanResult.stdout.includes(anchor))
    ) {
      throw new Error("packed CLI human inspection omitted exact review facts");
    }
    if (
      rpcMethods.length !== 0 ||
      [inspectJsonResult.stdout, inspectJsonResult.stderr, inspectHumanResult.stdout].some(
        (output) => output.includes(inspectSecret) || output.includes(rpcSecret),
      )
    ) {
      throw new Error("packed CLI inspection accessed RPC or leaked environment material");
    }
    const storeAfterInspect = await Promise.all(
      [...(await readdir(storeDirectory))]
        .sort()
        .map(async (filename) => [
          filename,
          await readFile(join(storeDirectory, filename), "utf8"),
        ]),
    );
    if (
      (await readFile(planPath, "utf8")) !== planBeforeInspect ||
      JSON.stringify(storeAfterInspect) !== JSON.stringify(storeBeforeInspect) ||
      JSON.stringify(await snapshotWorkingTree(consumer)) !== JSON.stringify(consumerBeforeInspect)
    ) {
      throw new Error("packed CLI inspection mutated its plan, run store, or working directory");
    }

    const reviewResult = await runCaptured("pnpm", reviewArguments, consumer, reviewEnvironment);
    const review = JSON.parse(reviewResult.stdout);
    const reviewedChain = review.provider?.chains?.[0];
    if (
      reviewResult.status !== 2 ||
      reviewResult.stderr !== "" ||
      review.version !== "moesi.cli-execution-review/v1" ||
      review.planId !== plan.planId ||
      review.provider?.providerId !== "viem" ||
      review.provider?.status !== "supported" ||
      review.provider?.chains?.length !== 1 ||
      typeof reviewedChain?.sender !== "string" ||
      reviewedChain.route !== "viem-direct-eoa:confirmations-2" ||
      reviewedChain.enforcement?.calls !== "interactive-owner" ||
      reviewedChain.enforcement?.expiry !== "not-enforced" ||
      reviewedChain.enforcement?.operationCount !== "not-enforced" ||
      review.resources?.length !== 1 ||
      review.resources?.[0]?.resourceId !== "counter" ||
      review.resources?.[0]?.resourceKind !== "managed" ||
      review.resources?.[0]?.address !== plan.cells[0]?.address ||
      review.steps?.length !== plan.steps.length ||
      review.steps?.[0]?.call?.target !== plan.steps[0]?.call.target ||
      review.steps?.[0]?.call?.data !== plan.steps[0]?.call.data ||
      review.steps?.[0]?.call?.value !== plan.steps[0]?.call.value ||
      !/^0x[0-9a-f]{64}$/.test(review.reviewId) ||
      !/^0x[0-9a-f]{64}$/.test(review.runStoreId)
    ) {
      throw new Error("packed CLI execution review projection is invalid");
    }
    if (
      reviewResult.stdout.includes(privateKey) ||
      reviewResult.stderr.includes(privateKey) ||
      reviewResult.stdout.includes(rpcSecret) ||
      reviewResult.stderr.includes(rpcSecret)
    ) {
      throw new Error("packed CLI review leaked signer or RPC material");
    }
    try {
      await readdir(reviewStoreDirectory);
      throw new Error("packed CLI review-only apply created durable run state");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (JSON.stringify(rpcMethods) !== JSON.stringify(["eth_chainId"])) {
      throw new Error("packed CLI review made an unexpected RPC request");
    }

    const rawArtifactResult = await runCaptured(
      "pnpm",
      reviewArguments.map((value) => (value === planPath ? rawPlanPath : value)),
      consumer,
      reviewEnvironment,
    );
    if (
      rawArtifactResult.status !== 1 ||
      JSON.parse(rawArtifactResult.stderr).error?.code !== "plan_artifact_invalid" ||
      rawArtifactResult.stdout !== ""
    ) {
      throw new Error("packed CLI accepted a raw plan without its artifact envelope");
    }

    const implicitProviderArguments = reviewArguments.filter(
      (value, index, values) => value !== "--provider" && values[index - 1] !== "--provider",
    );
    const implicitProviderResult = await runCaptured(
      "pnpm",
      implicitProviderArguments,
      consumer,
      reviewEnvironment,
    );
    if (
      implicitProviderResult.status !== 1 ||
      JSON.parse(implicitProviderResult.stderr).error?.code !== "invalid_arguments" ||
      implicitProviderResult.stdout !== ""
    ) {
      throw new Error("packed CLI selected an execution provider implicitly");
    }

    const verifyEnvironment = { ...process.env };
    delete verifyEnvironment.MOESI_PACKED_PRIVATE_KEY;
    const verifyResult = await runCaptured(
      "pnpm",
      ["exec", "moesi", "verify", "--plan", planPath, "--chain", `1=${rpcUrl}`, "--json"],
      consumer,
      verifyEnvironment,
    );
    const verification = JSON.parse(verifyResult.stdout);
    if (
      verifyResult.status !== 0 ||
      verifyResult.stderr !== "" ||
      verification.version !== "moesi.verification-result/v1" ||
      verification.planId !== plan.planId ||
      verification.manifestHash !== plan.manifestHash ||
      verification.status !== "converged" ||
      verification.chains?.[0]?.chainId !== 1 ||
      verification.chains?.[0]?.cells?.[0]?.status?.kind !== "satisfied"
    ) {
      throw new Error("packed CLI standalone verification failed");
    }
    if (
      JSON.stringify(rpcMethods) !==
      JSON.stringify([
        "eth_chainId",
        "eth_chainId",
        "eth_getBlockByNumber",
        "eth_chainId",
        "eth_getBlockByHash",
        "eth_getCode",
      ])
    ) {
      throw new Error("packed CLI verification made an unexpected RPC request");
    }
    if (
      verifyResult.stdout.includes(privateKey) ||
      verifyResult.stderr.includes(privateKey) ||
      verifyResult.stdout.includes(rpcSecret) ||
      verifyResult.stderr.includes(rpcSecret)
    ) {
      throw new Error("packed CLI verification leaked signer or RPC material");
    }
    try {
      await readdir(reviewStoreDirectory);
      throw new Error("packed CLI verification created durable run state");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const externalManifestPath = join(consumer, "external-manifest.json");
    const externalPlanPath = join(consumer, "external-plan.json");
    await writeFile(
      externalManifestPath,
      `${JSON.stringify({
        version: "moesi.manifest/v1",
        contracts: [
          {
            kind: "external",
            id: "registry",
            address: externalAddress,
            expectedRuntimeCodeHash: resourceRuntimeHash,
            checks: [
              {
                id: "live",
                caller: externalCaller,
                readData: externalReadData,
                expectedResult: externalExpectedResult,
              },
            ],
            storageChecks: [
              {
                id: "admin",
                slot: externalStorageSlot,
                expectedWord: externalExpectedWord,
              },
            ],
          },
        ],
      })}\n`,
    );
    const externalRpcOffset = rpcMethods.length;
    const externalTargetOffset = rpcCodeTargets.length;
    const externalCallOffset = rpcCallParams.length;
    const externalStorageOffset = rpcStorageParams.length;
    const externalPlanArguments = [
      "exec",
      "moesi",
      "plan",
      "--manifest",
      externalManifestPath,
      "--chain",
      `1=${rpcUrl}`,
      "--json",
    ];
    const externalTreeBeforePlan = await snapshotWorkingTree(consumer);
    const externalPlanResult = await runCaptured(
      "pnpm",
      externalPlanArguments,
      consumer,
      verifyEnvironment,
    );
    const externalArtifact = JSON.parse(externalPlanResult.stdout);
    const externalPlan = externalArtifact.plan;
    if (
      externalPlanResult.status !== 0 ||
      externalPlanResult.stderr !== "" ||
      externalArtifact.version !== "moesi.cli-plan/v1" ||
      externalPlan?.manifest?.contracts?.[0]?.kind !== "external" ||
      externalPlan?.cells?.[0]?.resourceId !== "registry" ||
      externalPlan?.cells?.[0]?.address !== externalAddress ||
      externalPlan?.cells?.[0]?.status?.kind !== "converged" ||
      externalPlan?.cells?.[0]?.configuration?.length !== 0 ||
      externalPlan?.cells?.[0]?.checks?.length !== 1 ||
      externalPlan?.cells?.[0]?.checks?.[0]?.caller !== externalCaller ||
      externalPlan?.cells?.[0]?.storageChecks?.length !== 1 ||
      externalPlan?.cells?.[0]?.storageChecks?.[0]?.slot !== externalStorageSlot ||
      externalPlan?.cells?.[0]?.status?.storageResults?.[0]?.word !== externalExpectedWord ||
      externalPlan?.capabilities?.length !== 0 ||
      externalPlan?.steps?.length !== 0 ||
      externalPlan?.requirements?.length !== 0
    ) {
      throw new Error("packed CLI external planning projection is invalid");
    }
    if (
      JSON.stringify(await snapshotWorkingTree(consumer)) !== JSON.stringify(externalTreeBeforePlan)
    ) {
      throw new Error("packed CLI external planning created signer or store state");
    }
    await writeFile(externalPlanPath, `${JSON.stringify(externalArtifact)}\n`);
    const externalTreeBeforeReadOnly = await snapshotWorkingTree(consumer);

    const externalInspect = await runCaptured(
      "pnpm",
      ["exec", "moesi", "inspect", "--plan", externalPlanPath],
      consumer,
      verifyEnvironment,
    );
    if (
      externalInspect.status !== 0 ||
      externalInspect.stderr !== "" ||
      !externalInspect.stdout.includes(
        `manifest contract registry kind=external address=${externalAddress} mode=verify-only execution-authority=none`,
      ) ||
      !externalInspect.stdout.includes(
        `manifest-call-check registry live simulation-caller=${externalCaller} readData=${externalReadData} expected=${externalExpectedResult} remediation=none execution-authority=none`,
      ) ||
      !externalInspect.stdout.includes(
        `manifest-storage-check registry admin slot=${externalStorageSlot} expected=${externalExpectedWord} remediation=none execution-authority=none`,
      ) ||
      !externalInspect.stdout.includes(
        `call-check-observation 1 registry live status=satisfied simulation-caller=${externalCaller} readData=${externalReadData} expected=${externalExpectedResult} observed=${externalExpectedResult} remediation=none execution-authority=none`,
      ) ||
      !externalInspect.stdout.includes(
        `storage-check-observation 1 registry admin status=satisfied slot=${externalStorageSlot} expected=${externalExpectedWord} observed=${externalExpectedWord} remediation=none execution-authority=none`,
      ) ||
      !externalInspect.stdout.includes("capabilities 0") ||
      !externalInspect.stdout.includes("steps 0") ||
      !externalInspect.stdout.includes("requirements 0")
    ) {
      throw new Error("packed CLI external inspection omitted verify-only facts");
    }

    const externalVerifyArguments = [
      "exec",
      "moesi",
      "verify",
      "--plan",
      externalPlanPath,
      "--chain",
      `1=${rpcUrl}`,
    ];
    const externalVerify = await runCaptured(
      "pnpm",
      externalVerifyArguments,
      consumer,
      verifyEnvironment,
    );
    if (
      externalVerify.status !== 0 ||
      externalVerify.stderr !== "" ||
      !externalVerify.stdout.includes(
        `1 registry runtime satisfied address=${externalAddress} expected=${resourceRuntimeHash} observed=${resourceRuntimeHash} kind=external mode=verify-only execution-authority=none`,
      ) ||
      !externalVerify.stdout.includes(
        `1 registry call-check live satisfied simulation-caller=${externalCaller} readData=${externalReadData} expected=${externalExpectedResult} observed=${externalExpectedResult} remediation=none execution-authority=none`,
      ) ||
      !externalVerify.stdout.includes(
        `1 registry storage-check admin satisfied slot=${externalStorageSlot} expected=${externalExpectedWord} observed=${externalExpectedWord} remediation=none execution-authority=none`,
      )
    ) {
      throw new Error("packed CLI external verification omitted exact runtime evidence");
    }

    externalStorageMode = "drifted";
    const externalStorageDrift = await runCaptured(
      "pnpm",
      externalVerifyArguments,
      consumer,
      verifyEnvironment,
    );
    if (
      externalStorageDrift.status !== 2 ||
      externalStorageDrift.stderr !== "" ||
      !externalStorageDrift.stdout.includes(
        `1 registry storage-check admin drifted slot=${externalStorageSlot} expected=${externalExpectedWord} observed=${externalDriftWord} remediation=none execution-authority=none`,
      )
    ) {
      throw new Error("packed CLI external storage drift evidence is invalid");
    }

    externalStorageMode = "unreadable";
    const externalStorageUnreadable = await runCaptured(
      "pnpm",
      externalVerifyArguments,
      consumer,
      verifyEnvironment,
    );
    externalStorageMode = "satisfied";
    if (
      externalStorageUnreadable.status !== 3 ||
      externalStorageUnreadable.stderr !== "" ||
      externalStorageUnreadable.stdout.includes("secret packed external storage failure") ||
      !externalStorageUnreadable.stdout.includes(
        `1 registry storage-check admin unreadable slot=${externalStorageSlot} expected=${externalExpectedWord} observed=unavailable reason=read-failed remediation=none execution-authority=none`,
      )
    ) {
      throw new Error("packed CLI external storage unreadable evidence is invalid");
    }

    externalCallMode = "drifted";
    const externalDrift = await runCaptured(
      "pnpm",
      externalVerifyArguments,
      consumer,
      verifyEnvironment,
    );
    if (
      externalDrift.status !== 2 ||
      externalDrift.stderr !== "" ||
      !externalDrift.stdout.includes(
        `1 registry call-check live drifted simulation-caller=${externalCaller} readData=${externalReadData} expected=${externalExpectedResult} observed=${externalDriftResult} remediation=none execution-authority=none`,
      )
    ) {
      throw new Error("packed CLI external check drift evidence is invalid");
    }

    externalCallMode = "unreadable";
    const externalUnreadable = await runCaptured(
      "pnpm",
      externalVerifyArguments,
      consumer,
      verifyEnvironment,
    );
    externalCallMode = "satisfied";
    if (
      externalUnreadable.status !== 3 ||
      externalUnreadable.stderr !== "" ||
      externalUnreadable.stdout.includes("secret packed external check failure") ||
      !externalUnreadable.stdout.includes(
        `1 registry call-check live unreadable simulation-caller=${externalCaller} readData=${externalReadData} expected=${externalExpectedResult} observed=unavailable reason=read-failed remediation=none execution-authority=none`,
      )
    ) {
      throw new Error("packed CLI external check unreadable evidence is invalid");
    }

    const expectedExternalCallParams = [
      { from: externalCaller, to: externalAddress, data: externalReadData },
      { blockHash: hash("2"), requireCanonical: true },
    ];
    const expectedExternalStorageParams = [
      externalAddress,
      externalStorageSlot,
      { blockHash: hash("2"), requireCanonical: true },
    ];
    const externalMethods = rpcMethods.slice(externalRpcOffset);
    const externalCalls = rpcCallParams.slice(externalCallOffset);
    const externalStorageReads = rpcStorageParams.slice(externalStorageOffset);
    if (
      [externalPlanArguments, externalVerifyArguments].some((arguments_) =>
        ["--provider", "--signer", "--store"].some((flag) => arguments_.includes(flag)),
      ) ||
      externalMethods.some(
        (method) =>
          method !== "eth_chainId" &&
          method !== "eth_getBlockByNumber" &&
          method !== "eth_getBlockByHash" &&
          method !== "eth_getCode" &&
          method !== "eth_getStorageAt" &&
          method !== "eth_call",
      ) ||
      rpcCodeTargets.slice(externalTargetOffset).length !== 6 ||
      rpcCodeTargets.slice(externalTargetOffset).some((target) => target !== externalAddress) ||
      externalCalls.length !== 5 ||
      externalCalls.some(
        (params) =>
          params?.length !== 2 ||
          JSON.stringify(params) !== JSON.stringify(expectedExternalCallParams),
      ) ||
      externalStorageReads.length !== 6 ||
      externalStorageReads.some(
        (params) =>
          params?.length !== 3 ||
          JSON.stringify(params) !== JSON.stringify(expectedExternalStorageParams),
      ) ||
      JSON.stringify(await snapshotWorkingTree(consumer)) !==
        JSON.stringify(externalTreeBeforeReadOnly)
    ) {
      throw new Error("packed CLI external checks crossed their read-only authority boundary");
    }

    const managedAttestationManifestPath = join(consumer, "managed-attestation-manifest.json");
    const managedAttestationPlanPath = join(consumer, "managed-attestation-plan.json");
    await writeFile(
      managedAttestationManifestPath,
      `${JSON.stringify({
        version: "moesi.manifest/v1",
        contracts: [
          {
            kind: "managed",
            id: "counter-attestation",
            deployment: {
              kind: "create2-factory-v1",
              requiresRuntime: ["registry"],
              salt: hash("c"),
              initCode: "0x60006000",
              value: "0",
            },
            expectedRuntimeCodeHash: resourceRuntimeHash,
            checks: [
              {
                id: "owner",
                caller: externalCaller,
                readData: externalReadData,
                expectedResult: externalExpectedResult,
              },
            ],
            storageChecks: [
              {
                id: "marker",
                slot: externalStorageSlot,
                expectedWord: externalExpectedWord,
              },
            ],
            configuration: [],
          },
          {
            kind: "external",
            id: "registry",
            address: externalAddress,
            expectedRuntimeCodeHash: resourceRuntimeHash,
            checks: [],
            storageChecks: [],
          },
        ],
      })}\n`,
    );
    const managedRpcOffset = rpcMethods.length;
    const managedTargetOffset = rpcCodeTargets.length;
    const managedCallOffset = rpcCallParams.length;
    const managedStorageOffset = rpcStorageParams.length;
    const managedPlanArguments = [
      "exec",
      "moesi",
      "plan",
      "--manifest",
      managedAttestationManifestPath,
      "--chain",
      `1=${rpcUrl}`,
      "--json",
    ];
    const managedPlanResult = await runCaptured(
      "pnpm",
      managedPlanArguments,
      consumer,
      verifyEnvironment,
    );
    const managedArtifact = JSON.parse(managedPlanResult.stdout);
    const managedPlan = managedArtifact.plan;
    if (
      managedPlanResult.status !== 0 ||
      managedPlanResult.stderr !== "" ||
      managedArtifact.version !== "moesi.cli-plan/v1" ||
      managedPlan?.manifest?.contracts?.[0]?.kind !== "managed" ||
      managedPlan?.manifest?.contracts?.[0]?.deployment?.requiresRuntime?.[0] !== "registry" ||
      managedPlan?.cells?.[0]?.address !== plan.cells[0]?.address ||
      managedPlan?.cells?.[0]?.status?.kind !== "converged" ||
      managedPlan?.cells?.[0]?.checks?.[0]?.id !== "owner" ||
      managedPlan?.cells?.[0]?.storageChecks?.[0]?.id !== "marker" ||
      managedPlan?.cells?.[0]?.status?.callResults?.[0]?.result !== externalExpectedResult ||
      managedPlan?.cells?.[0]?.status?.storageResults?.[0]?.word !== externalExpectedWord ||
      managedPlan?.steps?.length !== 0 ||
      managedPlan?.requirements?.length !== 0
    ) {
      throw new Error("packed CLI managed attestation plan is invalid");
    }
    await writeFile(managedAttestationPlanPath, `${JSON.stringify(managedArtifact)}\n`);
    const managedTreeBeforeReadOnly = await snapshotWorkingTree(consumer);
    const managedInspect = await runCaptured(
      "pnpm",
      ["exec", "moesi", "inspect", "--plan", managedAttestationPlanPath],
      consumer,
      verifyEnvironment,
    );
    const managedVerifyArguments = [
      "exec",
      "moesi",
      "verify",
      "--plan",
      managedAttestationPlanPath,
      "--chain",
      `1=${rpcUrl}`,
    ];
    const managedVerify = await runCaptured(
      "pnpm",
      managedVerifyArguments,
      consumer,
      verifyEnvironment,
    );
    if (
      managedInspect.status !== 0 ||
      managedInspect.stderr !== "" ||
      !managedInspect.stdout.includes(
        `manifest-call-check counter-attestation owner simulation-caller=${externalCaller} readData=${externalReadData} expected=${externalExpectedResult} remediation=none execution-authority=none`,
      ) ||
      !managedInspect.stdout.includes(
        `manifest-storage-check counter-attestation marker slot=${externalStorageSlot} expected=${externalExpectedWord} remediation=none execution-authority=none`,
      ) ||
      !managedInspect.stdout.includes(
        "manifest-deployment-runtime-prerequisite resource=counter-attestation requires-runtime=registry",
      ) ||
      managedVerify.status !== 0 ||
      managedVerify.stderr !== "" ||
      !managedVerify.stdout.includes(
        `1 counter-attestation runtime satisfied address=${plan.cells[0]?.address} expected=${resourceRuntimeHash} observed=${resourceRuntimeHash} kind=managed`,
      ) ||
      !managedVerify.stdout.includes(
        `1 counter-attestation call-check owner satisfied simulation-caller=${externalCaller} readData=${externalReadData} expected=${externalExpectedResult} observed=${externalExpectedResult} remediation=none execution-authority=none`,
      ) ||
      !managedVerify.stdout.includes(
        `1 counter-attestation storage-check marker satisfied slot=${externalStorageSlot} expected=${externalExpectedWord} observed=${externalExpectedWord} remediation=none execution-authority=none`,
      )
    ) {
      throw new Error("packed CLI omitted managed read-only attestation evidence");
    }
    const expectedManagedCallParams = [
      { from: externalCaller, to: plan.cells[0]?.address, data: externalReadData },
      { blockHash: hash("2"), requireCanonical: true },
    ];
    const expectedManagedStorageParams = [
      plan.cells[0]?.address,
      externalStorageSlot,
      { blockHash: hash("2"), requireCanonical: true },
    ];
    if (
      [managedPlanArguments, managedVerifyArguments].some((arguments_) =>
        ["--provider", "--signer", "--store"].some((flag) => arguments_.includes(flag)),
      ) ||
      rpcMethods
        .slice(managedRpcOffset)
        .some(
          (method) =>
            method !== "eth_chainId" &&
            method !== "eth_getBlockByNumber" &&
            method !== "eth_getBlockByHash" &&
            method !== "eth_getCode" &&
            method !== "eth_getStorageAt" &&
            method !== "eth_call",
        ) ||
      rpcCodeTargets.slice(managedTargetOffset).length !== 4 ||
      rpcCodeTargets
        .slice(managedTargetOffset)
        .filter((target) => target === plan.cells[0]?.address).length !== 2 ||
      rpcCodeTargets.slice(managedTargetOffset).filter((target) => target === externalAddress)
        .length !== 2 ||
      rpcCallParams.slice(managedCallOffset).length !== 2 ||
      rpcCallParams
        .slice(managedCallOffset)
        .some((params) => JSON.stringify(params) !== JSON.stringify(expectedManagedCallParams)) ||
      rpcStorageParams.slice(managedStorageOffset).length !== 2 ||
      rpcStorageParams
        .slice(managedStorageOffset)
        .some(
          (params) => JSON.stringify(params) !== JSON.stringify(expectedManagedStorageParams),
        ) ||
      JSON.stringify(await snapshotWorkingTree(consumer)) !==
        JSON.stringify(managedTreeBeforeReadOnly)
    ) {
      throw new Error("packed CLI managed attestations crossed their read-only boundary");
    }
  } finally {
    await new Promise((resolve, reject) => {
      rpcServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function pack(directory) {
  const before = new Set(await readdir(temporary));
  run("pnpm", ["pack", "--pack-destination", temporary], directory);
  const tarballs = (await readdir(temporary)).filter(
    (entry) => entry.endsWith(".tgz") && !before.has(entry),
  );
  if (tarballs.length !== 1) throw new Error("package did not produce exactly one tarball");
  return tarballs[0];
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function runCaptured(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function snapshotWorkingTree(directory) {
  const snapshot = [];
  await visit(directory, "");
  return snapshot;

  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (relative === "" && entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const metadata = await lstat(path);
      const mode = metadata.mode & 0o777;
      if (entry.isDirectory()) {
        snapshot.push([name, "directory", mode]);
        await visit(path, name);
      } else if (entry.isFile()) {
        snapshot.push([name, "file", mode, (await readFile(path)).toString("base64")]);
      } else if (entry.isSymbolicLink()) {
        snapshot.push([name, "symlink", mode, await readlink(path)]);
      } else {
        snapshot.push([name, "other", mode]);
      }
    }
  }
}
