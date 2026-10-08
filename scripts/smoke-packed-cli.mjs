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
import { scrubCurrentProcessEnv } from "./scrub-live-rpc-env.mjs";

scrubCurrentProcessEnv();

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "moesi-packed-cli-"));

try {
  const sourceMoesiPackage = JSON.parse(
    await readFile(join(root, "packages/moesi/package.json"), "utf8"),
  );
  const sourceCliPackage = JSON.parse(
    await readFile(join(root, "packages/cli/package.json"), "utf8"),
  );
  assertCanonicalReleasePair(sourceMoesiPackage, sourceCliPackage);

  const moesiTarball = await pack(join(root, "packages/moesi"));
  const cliTarball = await pack(join(root, "packages/cli"));
  if (moesiTarball !== `moesi-${sourceMoesiPackage.version}.tgz`) {
    throw new Error(`packed core filename does not match its version: ${moesiTarball}`);
  }
  if (cliTarball !== `moesi-cli-${sourceCliPackage.version}.tgz`) {
    throw new Error(`packed CLI filename does not match its version: ${cliTarball}`);
  }
  assertPackedContents(join(temporary, moesiTarball), "moesi");
  assertPackedContents(join(temporary, cliTarball), "@moesi/cli");
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
        dependencies: {
          moesi: moesiSpec,
          "@moesi/cli": cliSpec,
          cetane: "0.0.4",
        },
        // Packing resolves workspace:*; keep the consumer on this exact tarball.
        overrides: {
          moesi: moesiSpec,
        },
      },
      null,
      2,
    )}\n`,
  );
  run("bun", ["install", "--prefer-offline", "--ignore-scripts", "--linker", "isolated"], consumer);

  const dependencyEntries = await readdir(join(consumer, "node_modules", ".bun"));
  if (
    dependencyEntries.some((name) => name.startsWith("@moesi+oaath@") || name.startsWith("@oaath+"))
  )
    throw new Error("cetane_consumer_must_not_install_oaath");
  for (const legacy of ["viem", "viem/accounts"]) {
    const isolated = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `try { import.meta.resolve(${JSON.stringify(legacy)}); process.exitCode = 1; } catch {}`,
      ],
      { cwd: consumer, env: process.env },
    );
    if (isolated.status !== 0) throw new Error("cetane_consumer_must_not_install_viem");
  }
  const installedCore = JSON.parse(
    await readFile(join(consumer, "node_modules", "moesi", "package.json"), "utf8"),
  );
  const installedCli = JSON.parse(
    await readFile(join(consumer, "node_modules", "@moesi", "cli", "package.json"), "utf8"),
  );
  if (
    installedCore.name !== sourceMoesiPackage.name ||
    installedCore.version !== sourceMoesiPackage.version ||
    installedCli.name !== sourceCliPackage.name ||
    installedCli.version !== sourceCliPackage.version ||
    !hasExactDependencies(installedCore.dependencies, { cetane: "0.0.4", yaml: "2.9.1" }) ||
    !hasExactDependencies(installedCli.dependencies, {
      moesi: installedCore.version,
      cetane: "0.0.4",
    }) ||
    installedCli.dependencies?.moesi !== installedCore.version ||
    JSON.stringify(installedCli.dependencies).includes("workspace:")
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
  const createXFactory = "0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed";
  const createXFactoryRuntime = (
    await readFile(join(root, "packages/moesi/test/fixtures/CreateX.runtime.hex"), "utf8")
  ).trim();
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
      version: "moesi.manifest/v8",
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
    "bun",
    [
      "run",
      "--silent",
      "moesi",
      "status",
      "--run",
      deploymentRun.runId,
      "--store",
      storeDirectory,
      "--json",
    ],
    { cwd: consumer, encoding: "utf8", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error("packed CLI status command failed");
  }
  const output = JSON.parse(result.stdout);
  if (
    output.version !== "moesi.cli-status/v3" ||
    output.run?.runId !== deploymentRun.runId ||
    output.run?.planId !== plan.planId ||
    output.run?.providerId !== providerId ||
    output.run?.revision !== 2 ||
    output.run?.executionState !== "recovery-required" ||
    output.run?.convergence !== "not-recorded" ||
    output.run?.operations?.[0]?.phase !== "submitted" ||
    output.run?.operations?.[0]?.reference?.reference !== hash("8")
  ) {
    throw new Error("packed CLI status projection is invalid");
  }
  if (JSON.stringify(await readdir(storeDirectory)) !== JSON.stringify(before)) {
    throw new Error("packed CLI status mutated its run store");
  }

  const planPath = join(consumer, "review-plan.json");
  const rawPlanPath = join(consumer, "raw-plan.json");
  const reviewStoreDirectory = join(consumer, "review-runs");
  await writeFile(planPath, `${JSON.stringify({ version: "moesi.cli-plan/v7", plan })}\n`);
  await writeFile(rawPlanPath, `${JSON.stringify(plan)}\n`);
  const rpcMethods = [];
  const rpcCodeTargets = [];
  const rpcCallParams = [];
  const rpcStorageParams = [];
  let externalCallMode = "satisfied";
  let externalStorageMode = "satisfied";
  let semanticOwnerResult = null;
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
        target === createXFactory
          ? createXFactoryRuntime
          : target === plan.cells[0]?.address || target === externalAddress
            ? resourceRuntime
            : "0x";
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
        result =
          semanticOwnerResult ??
          (externalCallMode === "drifted" ? externalDriftResult : externalExpectedResult);
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
    "run",
    "--silent",
    "moesi",
    "apply",
    "--plan",
    planPath,
    "--provider",
    "cetane",
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
    const inspectArguments = ["run", "--silent", "moesi", "inspect", "--plan", planPath, "--json"];
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
      "bun",
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
      "bun",
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

    const reviewResult = await runCaptured("bun", reviewArguments, consumer, reviewEnvironment);
    const review = JSON.parse(reviewResult.stdout);
    const reviewedChain = review.provider?.chains?.[0];
    if (
      reviewResult.status !== 2 ||
      reviewResult.stderr !== "" ||
      review.version !== "moesi.cli-execution-review/v10" ||
      review.planId !== plan.planId ||
      review.provider?.providerId !== "cetane" ||
      review.provider?.status !== "supported" ||
      review.provider?.chains?.length !== 1 ||
      typeof reviewedChain?.sender !== "string" ||
      reviewedChain.route !== "cetane-direct-eoa:confirmations-2" ||
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
      "bun",
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
      "bun",
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
      "bun",
      [
        "run",
        "--silent",
        "moesi",
        "verify",
        "--plan",
        planPath,
        "--chain",
        `1=${rpcUrl}`,
        "--json",
      ],
      consumer,
      verifyEnvironment,
    );
    const verification = JSON.parse(verifyResult.stdout);
    if (
      verifyResult.status !== 0 ||
      verifyResult.stderr !== "" ||
      verification.version !== "moesi.verification-result/v6" ||
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
        version: "moesi.manifest/v8",
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
    const baselinePath = join(consumer, "fleet-baseline.json");
    const baseline = {
      version: "moesi.fleet-baseline/v2",
      cells: [
        {
          chainId: 1,
          resourceId: "registry",
          kind: "external",
          address: externalAddress,
          expectedRuntimeCodeHash: resourceRuntimeHash,
          configuration: [],
          checks: [
            {
              kind: "call",
              id: "original-live",
              target: externalAddress,
              caller: externalCaller,
              readData: externalReadData,
              expectedResult: externalExpectedResult,
            },
          ],
          storageChecks: [
            { id: "original-admin", slot: externalStorageSlot, expectedWord: externalExpectedWord },
          ],
        },
      ],
    };
    const parityArguments = [
      "run",
      "--silent",
      "moesi",
      "check-parity",
      "--manifest",
      externalManifestPath,
      "--baseline",
      baselinePath,
      "--chain",
      `1=${rpcUrl}`,
      "--json",
    ];
    for (const mode of ["match", "different", "unreadable"]) {
      baseline.cells[0].checks[0].expectedResult =
        mode === "different" ? externalDriftResult : externalExpectedResult;
      externalCallMode = mode === "unreadable" ? "unreadable" : "satisfied";
      await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);
      const beforeParity = await snapshotWorkingTree(consumer);
      const rpcOffset = rpcMethods.length;
      const result = await runCaptured("bun", parityArguments, consumer, verifyEnvironment);
      const report = JSON.parse(result.stdout);
      if (
        result.status !== { match: 0, different: 2, unreadable: 3 }[mode] ||
        result.stderr !== "" ||
        report.version !== "moesi.fleet-parity/v2" ||
        report.status !== mode ||
        report.chains[0]?.snapshot?.blockHash !== hash("2")
      )
        throw new Error("packed CLI parity report or exit code is invalid");
      if (result.stdout.includes(rpcSecret) || result.stdout.includes("secret packed external"))
        throw new Error("packed CLI parity retained sensitive diagnostics");
      if (
        JSON.stringify(await snapshotWorkingTree(consumer)) !== JSON.stringify(beforeParity) ||
        rpcMethods
          .slice(rpcOffset)
          .some(
            (method) =>
              ![
                "eth_chainId",
                "eth_getBlockByNumber",
                "eth_getCode",
                "eth_call",
                "eth_getStorageAt",
              ].includes(method),
          )
      )
        throw new Error("packed CLI parity performed writes");
    }
    externalCallMode = "satisfied";
    const externalRpcOffset = rpcMethods.length;
    const externalTargetOffset = rpcCodeTargets.length;
    const externalCallOffset = rpcCallParams.length;
    const externalStorageOffset = rpcStorageParams.length;
    const externalPlanArguments = [
      "run",
      "--silent",
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
      "bun",
      externalPlanArguments,
      consumer,
      verifyEnvironment,
    );
    const externalArtifact = JSON.parse(externalPlanResult.stdout);
    const externalPlan = externalArtifact.plan;
    if (
      externalPlanResult.status !== 0 ||
      externalPlanResult.stderr !== "" ||
      externalArtifact.version !== "moesi.cli-plan/v7" ||
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
      "bun",
      ["run", "--silent", "moesi", "inspect", "--plan", externalPlanPath],
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
      "run",
      "--silent",
      "moesi",
      "verify",
      "--plan",
      externalPlanPath,
      "--chain",
      `1=${rpcUrl}`,
    ];
    const externalVerify = await runCaptured(
      "bun",
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
      "bun",
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
      "bun",
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
      "bun",
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
      "bun",
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
        version: "moesi.manifest/v8",
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
      "run",
      "--silent",
      "moesi",
      "plan",
      "--manifest",
      managedAttestationManifestPath,
      "--chain",
      `1=${rpcUrl}`,
      "--json",
    ];
    const managedPlanResult = await runCaptured(
      "bun",
      managedPlanArguments,
      consumer,
      verifyEnvironment,
    );
    const managedArtifact = JSON.parse(managedPlanResult.stdout);
    const managedPlan = managedArtifact.plan;
    if (
      managedPlanResult.status !== 0 ||
      managedPlanResult.stderr !== "" ||
      managedArtifact.version !== "moesi.cli-plan/v7" ||
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
      "bun",
      ["run", "--silent", "moesi", "inspect", "--plan", managedAttestationPlanPath],
      consumer,
      verifyEnvironment,
    );
    const managedVerifyArguments = [
      "run",
      "--silent",
      "moesi",
      "verify",
      "--plan",
      managedAttestationPlanPath,
      "--chain",
      `1=${rpcUrl}`,
    ];
    const managedVerify = await runCaptured(
      "bun",
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

    const createXManifestPath = join(consumer, "createx-manifest.json");
    const createXPlanPath = join(consumer, "createx-plan.json");
    const createXSender = "0xc3a5e4c8a4f4eb9d8a4eb9d8a4eb9d8a4eb44aab";
    const createXEntropyInput = "0x04A9469DB98E61F23775C1";
    const createXEntropy = createXEntropyInput.toLowerCase();
    const createXExpectedAddress = "0x9e66e2c5c6df57a7465bd4f1ece3ad00449bf05c";
    const createXExpectedCall =
      "0x26307668c3a5e4c8a4f4eb9d8a4eb9d8a4eb9d8a4eb44aab0004a9469db98e61f23775c1000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000026080000000000000000000000000000000000000000000000000000000000000";
    await writeFile(
      createXManifestPath,
      `${JSON.stringify({
        version: "moesi.manifest/v8",
        contracts: [
          {
            kind: "managed",
            id: "createx-counter",
            deployment: {
              kind: "createx-create2-v1",
              entropy: createXEntropyInput,
              initCode: "0x6080",
              value: "0",
              requiresRuntime: [],
            },
            expectedRuntimeCodeHash: resourceRuntimeHash,
            checks: [],
            storageChecks: [],
            configuration: [],
            sender: { kind: "owner-eoa", address: createXSender },
          },
        ],
      })}\n`,
    );
    const createXRpcOffset = rpcMethods.length;
    const createXTargetOffset = rpcCodeTargets.length;
    const createXPlanArguments = [
      "run",
      "--silent",
      "moesi",
      "plan",
      "--manifest",
      createXManifestPath,
      "--chain",
      `1=${rpcUrl}`,
    ];
    const createXJsonResult = await runCaptured(
      "bun",
      [...createXPlanArguments, "--json"],
      consumer,
      verifyEnvironment,
    );
    const createXArtifact = JSON.parse(createXJsonResult.stdout);
    const createXPlan = createXArtifact.plan;
    if (
      createXJsonResult.status !== 2 ||
      createXJsonResult.stderr !== "" ||
      createXArtifact.version !== "moesi.cli-plan/v7" ||
      createXPlan?.manifest?.contracts?.[0]?.deployment?.kind !== "createx-create2-v1" ||
      createXPlan?.manifest?.contracts?.[0]?.deployment?.entropy !== createXEntropy ||
      createXPlan?.cells?.[0]?.address !== createXExpectedAddress ||
      createXPlan?.capabilities?.[0]?.kind !== "createx-factory-v1" ||
      createXPlan?.capabilities?.[0]?.address !== createXFactory ||
      createXPlan?.capabilities?.[0]?.status?.kind !== "available" ||
      createXPlan?.steps?.[0]?.call?.target !== createXFactory ||
      createXPlan?.steps?.[0]?.call?.data !== createXExpectedCall ||
      createXPlan?.requirements?.[0]?.sender?.kind !== "reviewed-owner-eoa" ||
      createXPlan?.requirements?.[0]?.sender?.address !== createXSender
    ) {
      throw new Error("packed CLI CreateX plan lost its exact strategy facts");
    }
    await writeFile(createXPlanPath, `${JSON.stringify(createXArtifact)}\n`);
    const createXHumanPlan = await runCaptured(
      "bun",
      createXPlanArguments,
      consumer,
      verifyEnvironment,
    );
    const createXInspect = await runCaptured(
      "bun",
      ["run", "--silent", "moesi", "inspect", "--plan", createXPlanPath],
      consumer,
      verifyEnvironment,
    );
    if (
      createXHumanPlan.status !== 2 ||
      createXHumanPlan.stderr !== "" ||
      !createXHumanPlan.stdout.includes(
        `1 createx-counter ${createXExpectedAddress} missing kind=managed deployment=scheduled requires-runtime=none strategy=createx-create2-v1`,
      ) ||
      !createXHumanPlan.stdout.includes(
        `1 capability createx-factory-v1 available address=${createXFactory}`,
      ) ||
      createXInspect.status !== 0 ||
      createXInspect.stderr !== "" ||
      !createXInspect.stdout.includes(
        `manifest contract createx-counter deployment kind=createx-create2-v1 entropy=${createXEntropy} initCode=0x6080 value=0 requiresRuntime=none`,
      ) ||
      !createXInspect.stdout.includes(
        `cell 1 createx-counter address=${createXExpectedAddress} expectedRuntimeCodeHash=${resourceRuntimeHash} status=missing kind=managed deployment=scheduled requires-runtime=none strategy=createx-create2-v1`,
      ) ||
      !createXInspect.stdout.includes(`capability 1 createx-factory-v1 address=${createXFactory}`)
    ) {
      throw new Error("packed CLI omitted reviewed CreateX strategy evidence");
    }
    const createXMethods = rpcMethods.slice(createXRpcOffset);
    const createXTargets = rpcCodeTargets.slice(createXTargetOffset);
    if (
      createXPlanArguments.some((argument) =>
        ["--provider", "--signer", "--store"].includes(argument),
      ) ||
      createXMethods.some(
        (method) =>
          method !== "eth_chainId" && method !== "eth_getBlockByNumber" && method !== "eth_getCode",
      ) ||
      createXTargets.length !== 4 ||
      createXTargets.filter((target) => target === createXExpectedAddress).length !== 2 ||
      createXTargets.filter((target) => target === createXFactory).length !== 2
    ) {
      throw new Error("packed CLI CreateX planning crossed its read-only authority boundary");
    }
    const savedPlanPath = join(consumer, "saved-createx-plan.json");
    const saveArguments = [...createXPlanArguments, "--out", savedPlanPath, "--json"];
    const saved = await runCaptured("bun", saveArguments, consumer, verifyEnvironment);
    if (
      saved.status !== 2 ||
      saved.stderr !== "" ||
      (await readFile(savedPlanPath, "utf8")) !== saved.stdout
    ) {
      throw new Error("packed CLI did not save its exact plan artifact");
    }
    const existing = await runCaptured("bun", saveArguments, consumer, verifyEnvironment);
    if (
      existing.status !== 1 ||
      existing.stdout !== "" ||
      JSON.parse(existing.stderr).error?.code !== "plan_output_exists" ||
      (await readFile(savedPlanPath, "utf8")) !== saved.stdout
    ) {
      throw new Error("packed CLI did not preserve an existing reviewed plan");
    }
    const helpOffset = rpcMethods.length;
    const help = await runCaptured(
      "bun",
      ["run", "--silent", "moesi", "apply", "--help"],
      consumer,
      verifyEnvironment,
    );
    if (
      help.status !== 0 ||
      !help.stdout.includes("--accept-review") ||
      rpcMethods.length !== helpOffset
    ) {
      throw new Error("packed CLI help was unavailable offline");
    }
    const sourceJson = JSON.stringify(plan.manifest);
    const sourceYaml = `version: ${plan.manifest.version}\ncontracts:\n${plan.manifest.contracts.map((resource) => `  - ${JSON.stringify(resource)}`).join("\n")}\n`;
    const sourcePath = join(consumer, "manifest-source.yaml");
    await writeFile(sourcePath, sourceYaml);
    const textArgs = [
      "run",
      "--silent",
      "moesi",
      "plan",
      "--manifest",
      "-",
      "--chain",
      `1=${rpcUrl}`,
      "--json",
    ];
    const jsonStdin = await runCaptured("bun", textArgs, consumer, verifyEnvironment, sourceJson);
    const yamlStdin = await runCaptured("bun", textArgs, consumer, verifyEnvironment, sourceYaml);
    const yamlFile = await runCaptured(
      "bun",
      textArgs.map((value) => (value === "-" ? sourcePath : value)),
      consumer,
      verifyEnvironment,
    );
    if (
      jsonStdin.status !== yamlStdin.status ||
      jsonStdin.status !== yamlFile.status ||
      jsonStdin.stderr !== "" ||
      yamlStdin.stderr !== "" ||
      yamlFile.stderr !== "" ||
      jsonStdin.stdout !== yamlStdin.stdout ||
      jsonStdin.stdout !== yamlFile.stdout ||
      JSON.parse(jsonStdin.stdout).version !== "moesi.cli-plan/v7"
    )
      throw new Error("packed_manifest_text_identity_mismatch");
    const referenceSource = JSON.parse(sourceJson);
    const resource = referenceSource.contracts[0];
    if (resource.kind !== "managed") throw new Error("packed_reference_fixture_invalid");
    const ownWord = `0x${"0".repeat(24)}${plan.cells.find((cell) => cell.resourceId === resource.id).address.slice(2)}`;
    const reference = { kind: "resource-address-word", resourceId: resource.id };
    resource.configuration = [
      {
        id: "self-address",
        readData: "0x12345678",
        expectedResult: reference,
        writeData: { kind: "concat", parts: ["0x11223344", reference] },
        value: "0",
      },
    ];
    const literalSource = JSON.parse(JSON.stringify(referenceSource));
    literalSource.contracts[0].configuration[0].expectedResult = ownWord;
    literalSource.contracts[0].configuration[0].writeData = `0x11223344${ownWord.slice(2)}`;
    const referenced = await runCaptured(
      "bun",
      textArgs,
      consumer,
      verifyEnvironment,
      JSON.stringify(referenceSource),
    );
    const literal = await runCaptured(
      "bun",
      textArgs,
      consumer,
      verifyEnvironment,
      JSON.stringify(literalSource),
    );
    if (
      referenced.stderr !== "" ||
      literal.stderr !== "" ||
      referenced.status !== literal.status ||
      referenced.stdout !== literal.stdout ||
      referenced.stdout.includes("resource-address-word")
    )
      throw new Error("packed_reference_identity_mismatch");
    const beforeUnknownReference = rpcMethods.length;
    reference.resourceId = "missing";
    const unknownReference = await runCaptured(
      "bun",
      textArgs,
      consumer,
      verifyEnvironment,
      JSON.stringify(referenceSource),
    );
    if (
      unknownReference.status !== 1 ||
      JSON.parse(unknownReference.stderr).error.code !== "unknown_reference" ||
      rpcMethods.length !== beforeUnknownReference
    )
      throw new Error("packed_reference_rpc_boundary_failed");
    const semanticOffset = rpcMethods.length;
    semanticOwnerResult = `0x${"0".repeat(24)}${externalCaller.slice(2)}`;
    const semanticSource = {
      version: "moesi.manifest/v8",
      contracts: [
        {
          kind: "external",
          id: "owned",
          address: externalAddress,
          expectedRuntimeCodeHash: resourceRuntimeHash,
          checks: [],
          storageChecks: [],
          semanticChecks: [
            {
              kind: "ownable-owner",
              id: "admin",
              caller: externalCaller,
              expectedOwner: externalCaller,
            },
          ],
        },
      ],
    };
    const semanticPlan = await runCaptured(
      "bun",
      textArgs,
      consumer,
      verifyEnvironment,
      JSON.stringify(semanticSource),
    );
    const semanticArtifact = JSON.parse(semanticPlan.stdout);
    if (
      semanticPlan.status !== 0 ||
      semanticPlan.stderr !== "" ||
      semanticArtifact.plan.cells[0].checks[0].kind !== "ownable-owner" ||
      semanticArtifact.plan.steps.length !== 0
    ) {
      throw new Error("packed_semantic_plan_failed");
    }
    const semanticPath = join(consumer, "semantic-plan.json");
    await writeFile(semanticPath, semanticPlan.stdout);
    const semanticInspect = await runCaptured(
      "bun",
      ["run", "--silent", "moesi", "inspect", "--plan", semanticPath],
      consumer,
      verifyEnvironment,
    );
    if (
      semanticInspect.status !== 0 ||
      semanticInspect.stderr !== "" ||
      !semanticInspect.stdout.includes(
        `manifest-semantic-check owned admin kind=ownable-owner simulation-caller=${externalCaller} expected-owner=${externalCaller}`,
      ) ||
      !semanticInspect.stdout.includes(`kind=ownable-owner target=${externalAddress}`)
    ) {
      throw new Error("packed_semantic_inspection_failed");
    }
    const semanticVerifyArgs = [
      "run",
      "--silent",
      "moesi",
      "verify",
      "--plan",
      semanticPath,
      "--chain",
      `1=${rpcUrl}`,
      "--json",
    ];
    const semanticVerified = await runCaptured(
      "bun",
      semanticVerifyArgs,
      consumer,
      verifyEnvironment,
    );
    if (
      semanticVerified.status !== 0 ||
      semanticVerified.stderr !== "" ||
      JSON.parse(semanticVerified.stdout).chains[0].cells[0].callChecks[0].kind !== "ownable-owner"
    ) {
      throw new Error("packed_semantic_verify_failed");
    }
    semanticOwnerResult = `0x${"0".repeat(64)}`;
    const semanticDrift = await runCaptured("bun", semanticVerifyArgs, consumer, verifyEnvironment);
    semanticOwnerResult = "0x";
    const semanticInvalid = await runCaptured(
      "bun",
      semanticVerifyArgs,
      consumer,
      verifyEnvironment,
    );
    if (
      semanticDrift.status !== 2 ||
      semanticInvalid.status !== 3 ||
      JSON.parse(semanticDrift.stdout).status !== "drifted" ||
      JSON.parse(semanticInvalid.stdout).status !== "unreadable" ||
      rpcMethods
        .slice(semanticOffset)
        .some(
          (method) =>
            !["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(method),
        )
    ) {
      throw new Error("packed_semantic_evidence_boundary_failed");
    }
    semanticOwnerResult = null;
    const beforeInvalidText = rpcMethods.length;
    for (const source of [
      "version: a\nversion: b",
      "---\na: 1\n---\nb: 2",
      `${sourceYaml}# ${String.fromCharCode(0)}\n`,
    ]) {
      const invalid = await runCaptured("bun", textArgs, consumer, verifyEnvironment, source);
      if (
        invalid.status !== 1 ||
        JSON.parse(invalid.stderr).error.code !== "invalid_manifest_document" ||
        invalid.stdout !== "" ||
        rpcMethods.length !== beforeInvalidText
      )
        throw new Error("packed_manifest_text_invalid_boundary");
    }
    const oversized = await runCaptured(
      "bun",
      textArgs,
      consumer,
      verifyEnvironment,
      "x".repeat(1_048_577),
    );
    if (
      oversized.status !== 1 ||
      JSON.parse(oversized.stderr).error.code !== "manifest_source_too_large" ||
      rpcMethods.length !== beforeInvalidText
    )
      throw new Error("packed_manifest_stdin_limit_failed");
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
  run("bun", ["pm", "pack", "--ignore-scripts", "--destination", temporary], directory);
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

function assertCanonicalReleasePair(moesiPackage, cliPackage) {
  if (moesiPackage.name !== "moesi" || cliPackage.name !== "@moesi/cli") {
    throw new Error("public package source manifests have unexpected names");
  }
  if (
    typeof moesiPackage.version !== "string" ||
    !/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(moesiPackage.version) ||
    cliPackage.version !== moesiPackage.version
  ) {
    throw new Error("public packages are not an equal canonical 0.x.y release pair");
  }
  if (
    !hasExactDependencies(moesiPackage.dependencies, { cetane: "0.0.4", yaml: "2.9.1" }) ||
    !hasExactDependencies(cliPackage.dependencies, { moesi: "workspace:*", cetane: "0.0.4" })
  ) {
    throw new Error("public package source dependencies are not release-canonical");
  }
}

function hasExactDependencies(actual, expected) {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  const actualNames = Object.keys(actual).sort(compareAscii);
  const expectedNames = Object.keys(expected).sort(compareAscii);
  return (
    JSON.stringify(actualNames) === JSON.stringify(expectedNames) &&
    expectedNames.every((name) => actual[name] === expected[name])
  );
}

function assertPackedContents(tarball, packageName) {
  const entries = packedEntries(tarball, packageName);
  let expected;
  if (packageName === "moesi") {
    const internal = entries.filter((entry) => /^dist\/operations-[A-Za-z0-9_-]+\.js$/.test(entry));
    const multicall3 = entries.filter((entry) =>
      /^dist\/multicall3-[A-Za-z0-9_-]+\.js$/.test(entry),
    );
    const provider = entries.filter((entry) =>
      /^dist\/provider-[A-Za-z0-9_-]+\.d\.ts$/.test(entry),
    );
    const shared = entries.filter((entry) => /^dist\/create-moesi-[A-Za-z0-9_-]+\.js$/.test(entry));
    const types = entries.filter((entry) => /^dist\/types-[A-Za-z0-9_-]+\.d\.ts$/.test(entry));
    const observations = entries.filter((entry) =>
      /^dist\/(?:observation-record|reviewed-plan)-[A-Za-z0-9_-]+\.js$/.test(entry),
    );
    const observationTypes = entries.filter((entry) =>
      /^dist\/observation-store-[A-Za-z0-9_-]+\.d\.ts$/.test(entry),
    );
    if (
      internal.length !== 1 ||
      multicall3.length !== 1 ||
      provider.length !== 1 ||
      shared.length !== 1 ||
      types.length !== 1 ||
      observations.length !== 2 ||
      observationTypes.length !== 1
    ) {
      throw new Error("packed moesi has unexpected generated chunk names");
    }
    expected = [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
      "contracts/CheckedBeacon.sol",
      "contracts/provenance.json",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/index.js.map",
      internal[0],
      `${internal[0]}.map`,
      multicall3[0],
      `${multicall3[0]}.map`,
      provider[0],
      shared[0],
      `${shared[0]}.map`,
      types[0],
      ...observations.flatMap((entry) => [entry, `${entry}.map`]),
      ...observationTypes,
      "dist/node/index.d.ts",
      "dist/node/index.js",
      "dist/node/index.js.map",
      "dist/fleet/index.d.ts",
      "dist/fleet/index.js",
      "dist/fleet/index.js.map",
      "dist/cetane/index.d.ts",
      "dist/cetane/index.js",
      "dist/cetane/index.js.map",
      "package.json",
    ];
  } else {
    expected = [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "dist/bin.js",
      "dist/bin.js.map",
      "package.json",
    ];
  }
  expected.sort(compareAscii);
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error(`packed ${packageName} contains unexpected files: ${entries.join(", ")}`);
  }
}

function packedEntries(tarball, packageName) {
  const result = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not inspect packed ${packageName} contents`);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith("package/")) {
        throw new Error(`packed ${packageName} contains a non-package path: ${entry}`);
      }
      return entry.slice("package/".length).replace(/\/$/, "");
    })
    .filter(Boolean)
    .sort(compareAscii);
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runCaptured(command, args, cwd, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(new Error("packed_stdin_pipe_failed"));
    });
    child.stdin.end(input);
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
