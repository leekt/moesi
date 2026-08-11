import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    installedCli.dependencies?.moesi !== installedCore.version
  ) {
    throw new Error("packed CLI is not bound to the exact packed core version");
  }

  const { createMoesi, MemoryDeploymentRunStore, parseDeploymentRunRecord } = await import(
    new URL("../packages/moesi/dist/index.js", import.meta.url)
  );
  const hash = (byte) => `0x${byte.repeat(64)}`;
  const address = (byte) => `0x${byte.repeat(40)}`;
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
    async readCode() {
      return "0x";
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
            factory: address("a"),
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
