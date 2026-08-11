import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const requireFromCli = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const requireFromCore = createRequire(new URL("../packages/moesi/package.json", import.meta.url));
const { keccak256 } = requireFromCli("viem");
const solc = requireFromCore("solc");

const CHAIN_ID = 31_337;
const TEST_ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CREATE2_FACTORY_ADDRESS = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const CREATE2_FACTORY_RUNTIME =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
const DRIFT_RUNTIME = "0x6001";
const SALT = `0x${"42".repeat(32)}`;
const temporary = await mkdtemp(join(tmpdir(), "moesi-cli-anvil-"));
const port = await availablePort();
const rpcUrl = `http://127.0.0.1:${port}`;
const anvil = spawn("anvil", ["--silent", "--chain-id", String(CHAIN_ID), "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForRpc(rpcUrl, anvil);
  const configurable = await compile("Configurable.sol", "Configurable");
  await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_ADDRESS, CREATE2_FACTORY_RUNTIME]);

  const manifestPath = join(temporary, "moesi.json");
  const planPath = join(temporary, "plan.json");
  const storePath = join(temporary, "runs");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: "moesi.manifest/v2",
      contracts: [
        {
          kind: "managed",
          id: "configurable",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: SALT,
            initCode: configurable.initCode,
            value: "0",
          },
          expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
          checks: [],
          storageChecks: [],
          configuration: [],
          sender: { kind: "owner-eoa", address: TEST_ACCOUNT },
        },
      ],
    })}\n`,
  );

  const planResult = runCli([
    "plan",
    "--manifest",
    manifestPath,
    "--chain",
    `${CHAIN_ID}=${rpcUrl}`,
    "--json",
  ]);
  if (planResult.status !== 2 || planResult.stderr !== "") {
    throw new Error("CLI planning failed");
  }
  const planArtifact = JSON.parse(planResult.stdout);
  const reviewedStep = planArtifact.plan?.steps?.[0];
  if (
    planArtifact.version !== "moesi.cli-plan/v1" ||
    planArtifact.plan?.capabilities?.[0]?.status?.kind !== "available" ||
    planArtifact.plan?.steps?.length !== 1 ||
    reviewedStep?.kind !== "deploy" ||
    reviewedStep?.call?.target !== CREATE2_FACTORY_ADDRESS
  ) {
    throw new Error("CLI plan artifact is invalid");
  }
  await writeFile(planPath, planResult.stdout);

  const executionArguments = [
    "apply",
    "--plan",
    planPath,
    "--provider",
    "viem",
    "--chain",
    `${CHAIN_ID}=${rpcUrl}`,
    "--signer",
    `${CHAIN_ID}=MOESI_CLI_ANVIL_PRIVATE_KEY`,
    "--confirmations",
    "2",
    "--store",
    storePath,
    "--observe-attempts",
    "1",
    "--observe-delay-ms",
    "0",
    "--json",
  ];
  const nonceBeforeReview = await nonce(rpcUrl);
  const preview = runCli(executionArguments, true);
  if (preview.status !== 2 || preview.stderr !== "") {
    throw new Error("CLI execution review failed");
  }
  const review = JSON.parse(preview.stdout);
  const reviewedChain = review.provider?.chains?.[0];
  if (
    review.version !== "moesi.cli-execution-review/v1" ||
    review.planId !== planArtifact.plan.planId ||
    review.provider?.providerId !== "viem" ||
    review.provider?.status !== "supported" ||
    review.provider?.reasons?.length !== 0 ||
    reviewedChain?.sender !== TEST_ACCOUNT ||
    reviewedChain?.route !== "viem-direct-eoa:confirmations-2" ||
    reviewedChain?.enforcement?.calls !== "interactive-owner" ||
    reviewedChain?.enforcement?.expiry !== "not-enforced" ||
    reviewedChain?.enforcement?.operationCount !== "not-enforced" ||
    review.steps?.[0]?.call?.target !== reviewedStep.call.target ||
    review.steps?.[0]?.call?.data !== reviewedStep.call.data ||
    review.steps?.[0]?.call?.value !== reviewedStep.call.value ||
    !/^0x[0-9a-f]{64}$/.test(review.reviewId)
  ) {
    throw new Error("CLI execution review is invalid");
  }
  if ((await nonce(rpcUrl)) !== nonceBeforeReview) {
    throw new Error("review-only CLI invocation submitted a transaction");
  }
  if (await pathExists(storePath)) {
    throw new Error("review-only CLI invocation created durable state");
  }

  const applied = runCli(
    [...executionArguments.slice(0, -1), "--accept-review", review.reviewId, "--json"],
    true,
  );
  if (applied.status !== 3 || applied.stderr !== "") {
    throw new Error("CLI apply did not retain an unresolved confirmed transaction");
  }
  const appliedOutput = JSON.parse(applied.stdout);
  const reference = appliedOutput.result?.chains?.[0]?.execution?.steps?.[0]?.reference?.reference;
  if (
    appliedOutput.version !== "moesi.cli-run-result/v1" ||
    appliedOutput.runState !== "recovery-required" ||
    appliedOutput.result?.runId !== planArtifact.plan.planId ||
    !/^viem-tx-v1:0x[0-9a-f]{64}:confirmations-2$/.test(reference)
  ) {
    throw new Error("CLI apply did not persist the exact viem reference");
  }
  const nonceAfterApply = await nonce(rpcUrl);
  if (nonceAfterApply !== nonceBeforeReview + 1n) {
    throw new Error("CLI apply did not submit exactly once");
  }
  const transactionHash = reference.slice(
    "viem-tx-v1:".length,
    reference.indexOf(":confirmations-"),
  );
  const transaction = await rpc(rpcUrl, "eth_getTransactionByHash", [transactionHash]);
  if (
    transaction?.from?.toLowerCase() !== TEST_ACCOUNT ||
    transaction?.to?.toLowerCase() !== reviewedStep.call.target ||
    transaction?.input?.toLowerCase() !== reviewedStep.call.data ||
    typeof transaction?.value !== "string" ||
    BigInt(transaction.value) !== BigInt(reviewedStep.call.value)
  ) {
    throw new Error("submitted transaction does not match the reviewed call");
  }

  const appliedStatus = runCli([
    "status",
    "--run",
    planArtifact.plan.planId,
    "--store",
    storePath,
    "--json",
  ]);
  const appliedStatusOutput = JSON.parse(appliedStatus.stdout);
  if (
    appliedStatus.status !== 0 ||
    appliedStatus.stderr !== "" ||
    appliedStatusOutput.run?.executionState !== "recovery-required" ||
    appliedStatusOutput.run?.steps?.[0]?.phase !== "submitted" ||
    appliedStatusOutput.run?.steps?.[0]?.reference?.reference !== reference
  ) {
    throw new Error("CLI status did not retain the submitted reference");
  }

  const receipt = await waitForReceipt(rpcUrl, transactionHash);
  const latestBlock = await rpc(rpcUrl, "eth_blockNumber", []);
  if (
    typeof receipt.blockNumber !== "string" ||
    typeof latestBlock !== "string" ||
    BigInt(receipt.blockNumber) !== BigInt(latestBlock)
  ) {
    throw new Error("CLI apply unexpectedly observed two confirmations");
  }

  await rpc(rpcUrl, "evm_mine", []);
  const resumed = runCli([
    "resume",
    "--run",
    planArtifact.plan.planId,
    "--provider",
    "viem",
    "--chain",
    `${CHAIN_ID}=${rpcUrl}`,
    "--confirmations",
    "2",
    "--store",
    storePath,
    "--observe-attempts",
    "1",
    "--observe-delay-ms",
    "0",
    "--json",
  ]);
  if (resumed.status !== 0 || resumed.stderr !== "") {
    throw new Error("CLI resume failed");
  }
  const resumedOutput = JSON.parse(resumed.stdout);
  if (
    resumedOutput.version !== "moesi.cli-run-result/v1" ||
    resumedOutput.runState !== "complete" ||
    resumedOutput.result?.status !== "converged" ||
    resumedOutput.result?.chains?.[0]?.execution?.steps?.[0]?.reference?.reference !== reference
  ) {
    throw new Error("CLI resume did not converge the retained reference");
  }
  if ((await nonce(rpcUrl)) !== nonceAfterApply) {
    throw new Error("CLI resume submitted another transaction");
  }

  const resumedStatus = runCli([
    "status",
    "--run",
    planArtifact.plan.planId,
    "--store",
    storePath,
    "--json",
  ]);
  const resumedStatusOutput = JSON.parse(resumedStatus.stdout);
  if (
    resumedStatus.status !== 0 ||
    resumedStatus.stderr !== "" ||
    resumedStatusOutput.run?.executionState !== "finalized" ||
    resumedStatusOutput.run?.steps?.[0]?.reference?.reference !== reference ||
    resumedStatusOutput.run?.steps?.[0]?.providerEvidence?.providerEvidenceId !== transactionHash
  ) {
    throw new Error("CLI status did not retain finalized provider evidence");
  }
  const deployedCode = await rpc(rpcUrl, "eth_getCode", [
    planArtifact.plan.cells[0].address,
    "latest",
  ]);
  if (deployedCode !== configurable.runtimeCode) {
    throw new Error("CLI resume did not verify the expected deployment code");
  }

  const verificationArguments = [
    "verify",
    "--plan",
    planPath,
    "--chain",
    `${CHAIN_ID}=${rpcUrl}`,
    "--json",
  ];
  const nonceBeforeVerification = await nonce(rpcUrl);
  const verified = runCli(verificationArguments, false);
  if (verified.status !== 0 || verified.stderr !== "") {
    throw new Error("keyless CLI verification failed");
  }
  const verifiedOutput = JSON.parse(verified.stdout);
  if (
    verifiedOutput.version !== "moesi.verification-result/v1" ||
    verifiedOutput.planId !== planArtifact.plan.planId ||
    verifiedOutput.manifestHash !== planArtifact.plan.manifestHash ||
    verifiedOutput.status !== "converged" ||
    verifiedOutput.chains?.[0]?.chainId !== CHAIN_ID ||
    verifiedOutput.chains?.[0]?.status !== "converged" ||
    verifiedOutput.chains?.[0]?.cells?.[0]?.resourceId !== "configurable" ||
    verifiedOutput.chains?.[0]?.cells?.[0]?.status?.kind !== "satisfied"
  ) {
    throw new Error("keyless CLI verification did not report exact convergence");
  }
  if ((await nonce(rpcUrl)) !== nonceBeforeVerification) {
    throw new Error("keyless CLI verification changed the deployer nonce");
  }

  await rpc(rpcUrl, "anvil_setCode", [planArtifact.plan.cells[0].address, DRIFT_RUNTIME]);
  await rpc(rpcUrl, "evm_mine", []);
  const driftedVerification = runCli(verificationArguments, false);
  if (driftedVerification.status !== 2 || driftedVerification.stderr !== "") {
    throw new Error("CLI verification did not use the drift exit code");
  }
  const driftedOutput = JSON.parse(driftedVerification.stdout);
  if (
    driftedOutput.version !== "moesi.verification-result/v1" ||
    driftedOutput.planId !== planArtifact.plan.planId ||
    driftedOutput.manifestHash !== planArtifact.plan.manifestHash ||
    driftedOutput.status !== "drifted" ||
    driftedOutput.chains?.[0]?.status !== "drifted" ||
    driftedOutput.chains?.[0]?.cells?.[0]?.status?.kind !== "drifted" ||
    driftedOutput.chains?.[0]?.cells?.[0]?.status?.observedRuntimeCodeHash !==
      keccak256(DRIFT_RUNTIME)
  ) {
    throw new Error("CLI verification did not report the mutated runtime as drift");
  }
  if ((await nonce(rpcUrl)) !== nonceBeforeVerification) {
    throw new Error("drift verification changed the deployer nonce");
  }
  await rpc(rpcUrl, "anvil_setCode", [
    planArtifact.plan.cells[0].address,
    configurable.runtimeCode,
  ]);
  await rpc(rpcUrl, "evm_mine", []);

  for (const output of [
    planResult.stdout,
    planResult.stderr,
    preview.stdout,
    preview.stderr,
    applied.stdout,
    applied.stderr,
    appliedStatus.stdout,
    appliedStatus.stderr,
    resumed.stdout,
    resumed.stderr,
    resumedStatus.stdout,
    resumedStatus.stderr,
    verified.stdout,
    verified.stderr,
    driftedVerification.stdout,
    driftedVerification.stderr,
  ]) {
    if (output.includes(TEST_PRIVATE_KEY)) throw new Error("CLI output leaked the private key");
  }
} finally {
  if (anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await new Promise((resolve) => {
      anvil.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
  }
  await rm(temporary, { recursive: true, force: true });
}

function runCli(arguments_, includePrivateKey = false) {
  const environment = { ...process.env };
  if (includePrivateKey) environment.MOESI_CLI_ANVIL_PRIVATE_KEY = TEST_PRIVATE_KEY;
  else delete environment.MOESI_CLI_ANVIL_PRIVATE_KEY;
  const result = spawnSync(
    process.execPath,
    [join(root, "packages/cli/dist/bin.js"), ...arguments_],
    {
      cwd: temporary,
      encoding: "utf8",
      env: environment,
    },
  );
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function compile(fileName, contractName) {
  const source = await readFile(
    new URL(`../packages/moesi/test/fixtures/${fileName}`, import.meta.url),
    "utf8",
  );
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { [fileName]: { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          outputSelection: {
            "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] },
          },
        },
      }),
    ),
  );
  const artifact = output.contracts?.[fileName]?.[contractName];
  const initCode = artifact?.evm?.bytecode?.object;
  const runtimeCode = artifact?.evm?.deployedBytecode?.object;
  if (typeof initCode !== "string" || typeof runtimeCode !== "string") {
    throw new Error(`solc did not produce ${contractName}`);
  }
  return { initCode: `0x${initCode}`, runtimeCode: `0x${runtimeCode}` };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address();
  if (typeof value !== "object" || value === null) throw new Error("failed to reserve a port");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return value.port;
}

async function waitForRpc(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Anvil exited before becoming ready");
    try {
      await rpc(url, "eth_chainId", []);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Anvil did not become ready");
}

async function waitForReceipt(url, transactionHash) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await rpc(url, "eth_getTransactionReceipt", [transactionHash]);
    if (value !== null && typeof value === "object") return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("transaction receipt was unavailable");
}

async function nonce(url) {
  const value = await rpc(url, "eth_getTransactionCount", [TEST_ACCOUNT, "latest"]);
  if (typeof value !== "string") throw new Error("account nonce is invalid");
  return BigInt(value);
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const value = await response.json();
  if (!response.ok || value.error !== undefined) throw new Error("local RPC request failed");
  return value.result;
}
