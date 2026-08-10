import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
          id: "counter",
          deployment: {
            kind: "create2-factory-v1",
            salt: hash("c"),
            initCode: "0x60006000",
            value: "0",
          },
          expectedRuntimeCodeHash: hash("d"),
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
  const rpcServer = createServer(async (request, response) => {
    let source = "";
    for await (const chunk of request) source += chunk;
    const value = JSON.parse(source);
    rpcMethods.push(value.method);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: value.id,
        ...(value.method === "eth_chainId"
          ? { result: "0x1" }
          : { error: { code: -32601, message: "method unavailable" } }),
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
