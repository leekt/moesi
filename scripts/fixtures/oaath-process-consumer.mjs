import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDirectory = await mkdtemp(join(tmpdir(), "moesi-oaath-process-"));
const environment = { ...process.env, MOESI_PROCESS_STATE: stateDirectory, NODE_NO_WARNINGS: "1" };
const manifest = JSON.parse(
  await readFile(new URL("./node_modules/@moesi/cli/package.json", import.meta.url), "utf8"),
);
const entry = new URL(`./node_modules/@moesi/cli/${manifest.bin.moesi}`, import.meta.url).pathname;
let producer;
let processIds = [];
let stage = "process_producer";

function message(child, expected) {
  return new Promise((resolve, reject) => {
    const done = (error, value) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error("process_timeout")), 30000);
    const onMessage = (value) => {
      if (value.type === expected) done(null, value);
      else if (value.type === "failed") done(new Error("producer_failed"));
    };
    const onExit = () => done(new Error("producer_exited"));
    const onError = () => done(new Error("producer_spawn_failed"));
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
async function stopProducer() {
  if (!producer || producer.exitCode !== null || producer.signalCode !== null) return;
  const exited = new Promise((resolve) => producer.once("exit", resolve));
  producer.kill("SIGKILL");
  await exited;
}
async function nonce(chain) {
  const response = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionCount",
      params: [chain.feePayer.address, "latest"],
    }),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  assert.match(result.result, /^0x[0-9a-f]+$/);
  return result.result;
}
function cli(args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    env: environment,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

try {
  producer = fork("oaath-cli-consumer.mjs", [], {
    env: environment,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const submitted = message(producer, "submitted");
  void submitted.catch(() => undefined);
  const metadata = await message(producer, "environment");
  processIds = metadata.processIds;
  const retained = await submitted;
  const chain = metadata.recovery.chains[0];
  const before = await nonce(chain);
  await stopProducer();
  assert.equal(producer.signalCode, "SIGKILL");
  // Public addresses/endpoints only. SDK authority remains in upstream-owned stores.
  await writeFile(join(stateDirectory, "recovery.json"), JSON.stringify(metadata.recovery));
  const chainArgs = ["--chain", `${chain.chainId}=${chain.rpcUrl}`];
  stage = "process_resume";
  const resumed = cli([
    "resume",
    "--run",
    retained.runId,
    "--provider",
    "oaath",
    "--oaath-client",
    "./oaath-recovery-client.mjs",
    "--store",
    join(stateDirectory, "runs"),
    ...chainArgs,
    "--observe-attempts",
    "1",
    "--json",
  ]);
  assert.equal(resumed.result.runId, retained.runId);
  assert.equal(resumed.result.status, "converged");
  assert.equal(resumed.result.chains[0].execution.operations.length, 1);
  assert.equal(resumed.result.chains[0].execution.operations[0].providerEvidence.calls.length, 2);
  assert.deepEqual(resumed.result.chains[0].execution.operations[0].reference, retained.reference);
  assert.equal(await nonce(chain), before);
  stage = "process_verify";
  cli(["verify", "--plan", join(stateDirectory, "plan.json"), ...chainArgs, "--json"]);
} catch {
  process.stderr.write(`packed_oaath_${stage}\n`);
  process.exitCode = 1;
} finally {
  await stopProducer();
  for (const pid of processIds) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = processIds.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) break;
    if (attempt === 99)
      for (const pid of alive) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await rm(stateDirectory, { recursive: true, force: true });
}
