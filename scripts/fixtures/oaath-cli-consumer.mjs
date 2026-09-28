import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keccak256 } from "viem";
import { fixture, stopAfterNextSend } from "./oaath-cli-client.mjs";

const manifest = JSON.parse(
  await readFile(new URL("./node_modules/@moesi/cli/package.json", import.meta.url), "utf8"),
);
const entry = new URL(`./node_modules/@moesi/cli/${manifest.bin.moesi}`, import.meta.url);
const directory = process.env.MOESI_PROCESS_STATE ?? ".";
const manifestPath = join(directory, "manifest.json");
const planPath = join(directory, "plan.json");
const runDirectory = join(directory, "runs");
let invocation = 0;
async function cli(args) {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let output = "";
  let errors = "";
  process.argv = [process.execPath, entry.pathname, ...args];
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    errors += String(chunk);
    return true;
  };
  try {
    // Re-evaluate the actual packed bin; SDK and database handles reopen on
    // every invocation. The fixture backing and this OS process remain alive.
    await import(`${entry.href}?invocation=${invocation++}`);
    assert.equal(errors, "");
    return { code: process.exitCode, output: JSON.parse(output) };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
let stage = "cli_plan";
try {
  const chainId = fixture.chainIds[0];
  const chain = ["--chain", `${chainId}=${fixture.rpcUrl(chainId)}`];
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: "moesi.manifest/v6",
      contracts: Array.from({ length: 2 }, (_, index) => ({
        kind: "managed",
        id: `counter-${index}`,
        deployment: {
          kind: "create2-factory-v1",
          requiresRuntime: [],
          salt: `0x${(index === 0 ? "ab" : "ac").repeat(32)}`,
          initCode: "0x6002600c60003960026000f36000",
          value: "0",
        },
        expectedRuntimeCodeHash: keccak256("0x6000"),
        configuration: [],
        checks: [],
        storageChecks: [],
      })),
    }),
  );
  const planned = await cli(["plan", "--manifest", manifestPath, ...chain, "--json"]);
  assert.equal(planned.code, 2);
  await writeFile(planPath, JSON.stringify(planned.output));
  const selected = ["--provider", "oaath", "--oaath-client", "./oaath-cli-client.mjs"];
  stage = "cli_authorize";
  const permission = await cli(["authorize", "--plan", planPath, ...selected, "--json"]);
  assert.equal(permission.code, 0);
  assert.equal(permission.output.status, "requested");
  assert.equal(fixture.approvalCount, 1);
  assert.equal(fixture.submissionCount, 0);
  const execution = [
    ...selected,
    ...chain,
    "--store",
    runDirectory,
    "--observe-attempts",
    "1",
    "--json",
  ];
  stage = "cli_review";
  const review = await cli(["apply", "--plan", planPath, ...execution]);
  assert.equal(review.code, 2);
  assert.equal(review.output.atomicity, "one-operation-per-chain");
  assert.equal(review.output.provider.status, "supported");
  assert.equal(review.output.packing, "per-chain");
  assert.deepEqual(review.output.operations, [
    { id: `chain-${chainId}`, chainId, stepIds: ["counter-0:deploy", "counter-1:deploy"] },
  ]);
  assert.equal(fixture.submissionCount, 0);
  stage = "cli_apply";
  stopAfterNextSend();
  const applied = await cli([
    "apply",
    "--plan",
    planPath,
    ...execution,
    "--accept-review",
    review.output.reviewId,
  ]);
  assert.equal(applied.code, 130);
  assert.equal(applied.output.stoppedBy, "SIGINT");
  assert.equal(fixture.submissionCount, 1);
  const id = applied.output.result.runId;
  const retained = applied.output.result.chains[0].execution.operations[0].reference;
  if (process.env.MOESI_PROCESS_STATE) {
    process.send({ type: "submitted", runId: id, reference: retained });
    // The parent SIGKILLs this producer before any resume/SDK observation.
    await new Promise(() => setInterval(() => {}, 1000));
  }
  stage = "cli_resume";
  const resumed = await cli(["resume", "--run", id, ...execution]);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.output.result.status, "converged");
  assert.equal(resumed.output.result.chains[0].execution.operations.length, 1);
  assert.equal(
    resumed.output.result.chains[0].execution.operations[0].providerEvidence.calls.length,
    2,
  );
  assert.deepEqual(resumed.output.result.chains[0].execution.operations[0].reference, retained);
  assert.equal(fixture.submissionCount, 1);
  assert.equal(fixture.approvalCount, 1);
  stage = "cli_verify";
  const verified = await cli(["verify", "--plan", planPath, ...chain, "--json"]);
  assert.equal(verified.code, 0);
} catch {
  if (process.env.MOESI_PROCESS_STATE) process.send({ type: "failed", stage });
  process.stderr.write(`packed_oaath_${stage}\n`);
  process.exitCode = 1;
} finally {
  await fixture.close();
}
