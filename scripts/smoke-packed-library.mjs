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
const create2Factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const create2FactoryRuntime = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
const resourceRuntime = "0x6000";
const resourceRuntimeHash = "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d";
const externalAddress = address("c");
const externalRuntime = "0x6002";
const externalRuntimeHash = "0xcde7aac41575d8b30bd84f598371d46d266fadb09c9dcfcdd047fd087ef8763e";
const externalDriftRuntime = "0x6003";
const externalDriftRuntimeHash = "0x124787cd33af4a91148bc5521374b123cb0c5aaa5b0f02ff8d9bf1bb816791b8";
let deployed = false;
let externalCode = externalRuntime;
const codeTargets = [];
const block = (number) => ({
  number: \`0x\${number.toString(16)}\`,
  hash: bytes32(String(number)),
  parentHash: bytes32(String(number - 1)),
});
const reader = {
  chain: { id: 1 },
  async request({ method, params }) {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return block(deployed ? 2 : 1);
    if (method === "eth_getBlockByHash") {
      const requested = params?.[0];
      if (requested === bytes32("2")) return block(2);
      if (requested === bytes32("1")) return block(1);
      return null;
    }
    if (method === "eth_getCode") {
      const target = params?.[0]?.toLowerCase();
      codeTargets.push(target);
      return target === create2Factory
        ? create2FactoryRuntime
        : target === externalAddress
          ? externalCode
        : deployed
          ? resourceRuntime
          : "0x";
    }
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
      kind: "managed",
      id: "counter",
      deployment: {
        kind: "create2-factory-v1",
        salt: bytes32("b"),
        initCode: "0x6000",
        value: "0",
      },
      expectedRuntimeCodeHash: resourceRuntimeHash,
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
  plan.capabilities?.[0]?.status?.kind !== "available" ||
  review.provider.status !== "supported" ||
  reloaded.planId !== plan.planId
) {
  throw new Error("packed Moesi public API smoke failed");
}
deployed = true;
const verification = await moesi.verify({ plan: reloaded });
if (
  verification.version !== "moesi.verification-result/v1" ||
  verification.planId !== plan.planId ||
  verification.manifestHash !== plan.manifestHash ||
  verification.status !== "converged" ||
  verification.chains?.length !== 1 ||
  verification.chains[0]?.chainId !== 1 ||
  verification.chains[0]?.status !== "converged" ||
  verification.chains[0]?.cells?.[0]?.status?.kind !== "satisfied"
) {
  throw new Error("packed Moesi standalone verification smoke failed");
}
codeTargets.length = 0;
const externalPlan = await moesi.plan({
  chains: [1],
  manifest: {
    version: "moesi.manifest/v1",
    contracts: [{
      kind: "external",
      id: "registry",
      address: externalAddress,
      expectedRuntimeCodeHash: externalRuntimeHash,
    }],
  },
});
const externalReloaded = parseReviewedPlan(JSON.parse(JSON.stringify(externalPlan)));
const externalVerification = await moesi.verify({ plan: externalReloaded });
externalCode = externalDriftRuntime;
const externalDrift = await moesi.verify({ plan: externalReloaded });
if (
  externalPlan.disposition !== "converged" ||
  externalPlan.cells?.[0]?.address !== externalAddress ||
  externalPlan.cells?.[0]?.configuration?.length !== 0 ||
  externalPlan.capabilities?.length !== 0 ||
  externalPlan.steps?.length !== 0 ||
  externalPlan.requirements?.length !== 0 ||
  externalVerification.status !== "converged" ||
  externalVerification.chains?.[0]?.cells?.[0]?.status?.kind !== "satisfied" ||
  externalDrift.status !== "drifted" ||
  externalDrift.chains?.[0]?.cells?.[0]?.status?.kind !== "drifted" ||
  externalDrift.chains?.[0]?.cells?.[0]?.status?.observedRuntimeCodeHash !==
    externalDriftRuntimeHash ||
  codeTargets.length !== 3 ||
  codeTargets.some((target) => target !== externalAddress)
) {
  throw new Error("packed exact-address external resource API smoke failed");
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
