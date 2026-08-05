import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "moesi-packed-"));

try {
  run("pnpm", ["pack", "--pack-destination", temporary], join(root, "packages/moesi"));
  const tarballName = (await readdir(temporary)).find((entry) => entry.endsWith(".tgz"));
  if (!tarballName) throw new Error("Moesi pack did not produce a tarball");

  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "moesi-packed-smoke",
        private: true,
        type: "module",
        dependencies: { moesi: `file:${join(temporary, tarballName)}` },
      },
      null,
      2,
    )}\n`,
  );
  run("pnpm", ["install", "--offline", "--ignore-scripts"], consumer);
  await writeFile(
    join(consumer, "index.mjs"),
    `import { createMoesi, parseReviewedPlan } from "moesi";
import { createViemExecutionProvider, createViemObservationAdapter } from "moesi/viem";

const bytes32 = (byte) => \`0x\${byte.repeat(64)}\`;
const address = (byte) => \`0x\${byte.repeat(40)}\`;
const reader = {
  chain: { id: 1 },
  async request({ method }) {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return { number: "0x1", hash: bytes32("1") };
    if (method === "eth_getCode") return "0x";
    if (method === "eth_call") return "0x";
    return null;
  },
};
const observer = createViemObservationAdapter({ publicClientForChain: () => reader });
const moesi = createMoesi({ observer });
const plan = await moesi.plan({
  chains: [1],
  manifest: {
    version: "moesi.manifest/v1",
    contracts: [{
      id: "counter",
      deployment: {
        kind: "create2-factory-v1",
        factory: address("a"),
        salt: bytes32("b"),
        initCode: "0x6000",
        value: "0",
      },
      expectedRuntimeCodeHash: bytes32("c"),
      configuration: [],
    }],
  },
});
const provider = createViemExecutionProvider({
  publicClientForChain: () => reader,
  walletClientForChain: () => ({
    account: { address: address("d"), type: "local" },
    chain: { id: 1 },
    async sendTransaction() { return bytes32("e"); },
  }),
  confirmations: 1,
});
const review = await moesi.reviewExecution({ plan, provider });
const reloaded = parseReviewedPlan(JSON.parse(JSON.stringify(plan)));
if (
  plan.disposition !== "changes" ||
  review.provider.status !== "supported" ||
  reloaded.planId !== plan.planId
) {
  throw new Error("packed Moesi public API smoke failed");
}
`,
  );
  run(process.execPath, ["index.mjs"], consumer);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
