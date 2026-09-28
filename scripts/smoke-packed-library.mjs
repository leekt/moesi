import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubCurrentProcessEnv } from "./scrub-live-rpc-env.mjs";

scrubCurrentProcessEnv();

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "moesi-packed-"));
const createXFactoryRuntime = (
  await readFile(join(root, "packages/moesi/test/fixtures/CreateX.runtime.hex"), "utf8")
).trim();

try {
  const sourcePackage = JSON.parse(
    await readFile(join(root, "packages/moesi/package.json"), "utf8"),
  );
  assertCanonicalPackage(sourcePackage, "moesi");

  run("pnpm", ["pack", "--pack-destination", temporary], join(root, "packages/moesi"));
  const tarballs = (await readdir(temporary)).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1 || tarballs[0] !== `moesi-${sourcePackage.version}.tgz`) {
    throw new Error(`Moesi pack produced unexpected tarballs: ${tarballs.join(", ")}`);
  }
  const tarballName = tarballs[0];
  assertCorePackedContents(join(temporary, tarballName));

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
  const installedPackage = JSON.parse(
    await readFile(join(consumer, "node_modules", "moesi", "package.json"), "utf8"),
  );
  if (
    installedPackage.name !== sourcePackage.name ||
    installedPackage.version !== sourcePackage.version
  ) {
    throw new Error("installed packed Moesi coordinates do not match its source manifest");
  }
  await writeFile(
    join(consumer, "index.mjs"),
    `import {
  CREATEX_DEPLOY_CREATE2_SELECTOR,
  CREATEX_FACTORY_V1_ADDRESS,
  CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
  createMoesi,
  deriveCreateXSenderProtectedRawSalt,
  parseManifestText,
  parseReviewedPlan,
} from "moesi";
import { createViemExecutionProvider, createViemObservationAdapter } from "moesi/viem";

const bytes32 = (byte) => \`0x\${byte.repeat(64)}\`;
const address = (byte) => \`0x\${byte.repeat(40)}\`;
const create2Factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const create2FactoryRuntime = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
const createXFactoryRuntime = ${JSON.stringify(createXFactoryRuntime)};
const resourceRuntime = "0x6000";
const resourceRuntimeHash = "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d";
const externalAddress = address("c");
const externalRuntime = "0x6002";
const externalRuntimeHash = "0xcde7aac41575d8b30bd84f598371d46d266fadb09c9dcfcdd047fd087ef8763e";
const externalDriftRuntime = "0x6003";
const externalDriftRuntimeHash = "0x124787cd33af4a91148bc5521374b123cb0c5aaa5b0f02ff8d9bf1bb816791b8";
const externalCaller = address("f");
const externalReadData = "0x5c975abb";
const externalExpectedResult = "0x01";
const externalDriftResult = "0x00";
const externalStorageSlot = bytes32("4");
const externalExpectedWord = bytes32("5");
const externalDriftWord = bytes32("6");
let deployed = false;
let externalCode = externalRuntime;
let externalCallMode = "satisfied";
let externalStorageMode = "satisfied";
const codeTargets = [];
const externalCallParams = [];
const externalStorageParams = [];
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
        : target === CREATEX_FACTORY_V1_ADDRESS
          ? createXFactoryRuntime
        : target === externalAddress
          ? externalCode
        : deployed
          ? resourceRuntime
          : "0x";
    }
    if (method === "eth_call") {
      externalCallParams.push(params);
      if (externalCallMode === "unreadable") throw new Error("bounded external call failure");
      return externalCallMode === "drifted" ? externalDriftResult : externalExpectedResult;
    }
    if (method === "eth_getStorageAt") {
      externalStorageParams.push(params);
      if (externalStorageMode === "unreadable") {
        throw new Error("bounded external storage failure");
      }
      return externalStorageMode === "drifted" ? externalDriftWord : externalExpectedWord;
    }
    return null;
  },
};
const observer = createViemObservationAdapter({ publicClientForChain: () => reader });
const moesi = createMoesi({ observer });
const discovery = await moesi.discover({
  chains: [1],
  resources: [{ address: externalAddress, caller: externalCaller, erc1967: true, ownable: true }],
});
const discoveryChain = discovery.chains[0];
const discovered = discoveryChain?.kind === "observed" ? discoveryChain.resources[0] : null;
if (discovery.version !== "moesi.discovery/v1" || discovered?.kind !== "deployed" ||
    discovered.runtimeCodeHash !== externalRuntimeHash || discovered.owner?.kind !== "unreadable" ||
    discovered.erc1967?.target.kind !== "unreadable" || !Object.isFrozen(discovered)) {
  throw new Error("packed discovery did not retain strict immutable read evidence");
}
// Keep the following plan proof's RPC counters scoped to planning.
codeTargets.length = 0;
externalCallParams.length = 0;
externalStorageParams.length = 0;
const plan = await moesi.plan({
  chains: [1],
  manifest: {
    version: "moesi.manifest/v5",
    contracts: [{
      kind: "managed",
      id: "counter",
      deployment: {
        kind: "create2-factory-v1",
        requiresRuntime: [],
        salt: bytes32("b"),
        initCode: "0x6000",
        value: "0",
      },
      expectedRuntimeCodeHash: resourceRuntimeHash,
      checks: [],
      storageChecks: [],
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
const fromJson = parseManifestText(JSON.stringify(plan.manifest));
const fromYaml = parseManifestText("version: " + plan.manifest.version + "\\ncontracts:\\n  - " + JSON.stringify(plan.manifest.contracts[0]));
const textPlan = await moesi.plan({ manifest: fromYaml, chains: [1] });
if (fromJson.manifestHash !== fromYaml.manifestHash || textPlan.planId !== plan.planId) {
  throw new Error("packed JSON/YAML manifest identity mismatch");
}
const referenceManifest = {
  ...plan.manifest,
  contracts: plan.manifest.contracts.map(resource => ({ ...resource, configuration: [{
    id: "self-address",
    readData: "0x12345678",
    expectedResult: { kind: "resource-address-word", resourceId: resource.id },
    writeData: { kind: "concat", parts: ["0x11223344", { kind: "resource-address-word", resourceId: resource.id }] },
    value: "0",
  }] })),
};
const referencePlan = await moesi.plan({ manifest: referenceManifest, chains: [1] });
const expectedAddressWord = "0x" + "0".repeat(24) + plan.cells[0].address.slice(2);
const configurationStep = referencePlan.steps.find(step => step.kind === "configure");
if (configurationStep?.call.data !== "0x11223344" + expectedAddressWord.slice(2) ||
    referencePlan.manifest.contracts[0].configuration[0].expectedResult !== expectedAddressWord ||
    JSON.stringify(referencePlan).includes("resource-address-word") ||
    (await moesi.plan({ manifest: referencePlan.manifest, chains: [1] })).planId !== referencePlan.planId) {
  throw new Error("packed manifest reference resolution failed");
}
if (
  plan.disposition !== "changes" ||
  plan.capabilities?.[0]?.status?.kind !== "available" ||
  review.provider.status !== "supported" ||
  reloaded.planId !== plan.planId
) {
  throw new Error("packed Moesi public API smoke failed");
}
const createXSender = "0xc3a5e4c8a4f4eb9d8a4eb9d8a4eb9d8a4eb44aab";
const createXEntropy = "0x04A9469DB98E61F23775C1";
const createXExpectedRawSalt =
  "0xc3a5e4c8a4f4eb9d8a4eb9d8a4eb9d8a4eb44aab0004a9469db98e61f23775c1";
const createXExpectedAddress = "0x9e66e2c5c6df57a7465bd4f1ece3ad00449bf05c";
const createXExpectedCall =
  "0x26307668c3a5e4c8a4f4eb9d8a4eb9d8a4eb9d8a4eb44aab0004a9469db98e61f23775c1000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000026080000000000000000000000000000000000000000000000000000000000000";
const createXPlan = await moesi.plan({
  chains: [1],
  manifest: {
    version: "moesi.manifest/v5",
    contracts: [{
      kind: "managed",
      id: "createx-counter",
      deployment: {
        kind: "createx-create2-v1",
        entropy: createXEntropy,
        initCode: "0x6080",
        value: "0",
        requiresRuntime: [],
      },
      expectedRuntimeCodeHash: resourceRuntimeHash,
      checks: [],
      storageChecks: [],
      configuration: [],
      sender: { kind: "owner-eoa", address: createXSender },
    }],
  },
});
const createXProvider = createViemExecutionProvider({
  publicClientForChain: () => reader,
  walletClientForChain: () => ({
    account: { address: createXSender, type: "local" },
    chain: { id: 1 },
    async sendTransaction() { return bytes32("a"); },
  }),
  confirmations: 1,
});
const createXReview = await moesi.reviewExecution({ plan: createXPlan, provider: createXProvider });
const createXReloaded = parseReviewedPlan(JSON.parse(JSON.stringify(createXPlan)));
if (
  CREATEX_FACTORY_V1_ADDRESS !== "0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed" ||
  CREATEX_FACTORY_V1_RUNTIME_CODE_HASH !==
    "0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f" ||
  CREATEX_DEPLOY_CREATE2_SELECTOR !== "0x26307668" ||
  deriveCreateXSenderProtectedRawSalt({ sender: createXSender, entropy: createXEntropy }) !==
    createXExpectedRawSalt ||
  createXPlan.manifest.contracts[0]?.deployment.entropy !== createXEntropy.toLowerCase() ||
  createXPlan.cells[0]?.address !== createXExpectedAddress ||
  createXPlan.capabilities[0]?.kind !== "createx-factory-v1" ||
  createXPlan.capabilities[0]?.address !== CREATEX_FACTORY_V1_ADDRESS ||
  createXPlan.capabilities[0]?.status.kind !== "available" ||
  createXPlan.steps[0]?.call.target !== CREATEX_FACTORY_V1_ADDRESS ||
  createXPlan.steps[0]?.call.data !== createXExpectedCall ||
  !createXPlan.steps[0]?.call.data.startsWith(CREATEX_DEPLOY_CREATE2_SELECTOR) ||
  createXReview.provider.status !== "supported" ||
  createXReloaded.planId !== createXPlan.planId
) {
  throw new Error("packed CreateX CREATE2 public API smoke failed");
}
const prerequisitePlan = await moesi.plan({
  chains: [1],
  manifest: {
    version: "moesi.manifest/v5",
    contracts: [
      {
        kind: "managed",
        id: "app",
        deployment: {
          kind: "create2-factory-v1",
          requiresRuntime: ["z-runtime"],
          salt: bytes32("c"),
          initCode: "0x6000",
          value: "0",
        },
        expectedRuntimeCodeHash: resourceRuntimeHash,
        checks: [],
        storageChecks: [],
        configuration: [],
      },
      {
        kind: "managed",
        id: "z-runtime",
        deployment: {
          kind: "create2-factory-v1",
          requiresRuntime: [],
          salt: bytes32("d"),
          initCode: "0x6000",
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
const prerequisiteReloaded = parseReviewedPlan(JSON.parse(JSON.stringify(prerequisitePlan)));
if (
  prerequisitePlan.steps.map(({ id }) => id).join(",") !== "z-runtime:deploy,app:deploy" ||
  JSON.stringify(prerequisitePlan.requirements?.[0]?.calls) !==
    JSON.stringify(prerequisitePlan.steps.map(({ call }) => call)) ||
  prerequisiteReloaded.planId !== prerequisitePlan.planId ||
  prerequisiteReloaded.manifest.contracts.find(({ id }) => id === "app")?.kind !== "managed" ||
  prerequisiteReloaded.manifest.contracts.find(({ id }) => id === "app")?.deployment
    .requiresRuntime[0] !== "z-runtime"
) {
  throw new Error("packed deployment runtime prerequisite API smoke failed");
}
deployed = true;
const verification = await moesi.verify({ plan: reloaded });
if (
  verification.version !== "moesi.verification-result/v3" ||
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
externalCallParams.length = 0;
externalStorageParams.length = 0;
const externalPlan = await moesi.plan({
  chains: [1],
  manifest: {
    version: "moesi.manifest/v5",
    contracts: [{
      kind: "external",
      id: "registry",
      address: externalAddress,
      expectedRuntimeCodeHash: externalRuntimeHash,
      checks: [{
        id: "live",
        caller: externalCaller,
        readData: externalReadData,
        expectedResult: externalExpectedResult,
      }],
      storageChecks: [{
        id: "admin",
        slot: externalStorageSlot,
        expectedWord: externalExpectedWord,
      }],
    }],
  },
});
const externalReloaded = parseReviewedPlan(JSON.parse(JSON.stringify(externalPlan)));
const externalVerification = await moesi.verify({ plan: externalReloaded });
externalStorageMode = "drifted";
const externalStorageDrift = await moesi.verify({ plan: externalReloaded });
externalStorageMode = "unreadable";
const externalStorageUnreadable = await moesi.verify({ plan: externalReloaded });
externalStorageMode = "satisfied";
externalCallMode = "drifted";
const externalCheckDrift = await moesi.verify({ plan: externalReloaded });
externalCallMode = "unreadable";
const externalCheckUnreadable = await moesi.verify({ plan: externalReloaded });
externalCallMode = "satisfied";
externalCode = externalDriftRuntime;
const externalRuntimeDrift = await moesi.verify({ plan: externalReloaded });
const expectedExternalCallParams = [
  { from: externalCaller, to: externalAddress, data: externalReadData },
  { blockHash: bytes32("2"), requireCanonical: true },
];
const expectedExternalStorageParams = [
  externalAddress,
  externalStorageSlot,
  { blockHash: bytes32("2"), requireCanonical: true },
];
if (
  externalPlan.disposition !== "converged" ||
  externalPlan.cells?.[0]?.address !== externalAddress ||
  externalPlan.cells?.[0]?.configuration?.length !== 0 ||
  externalPlan.cells?.[0]?.checks?.length !== 1 ||
  externalPlan.cells?.[0]?.checks?.[0]?.caller !== externalCaller ||
  externalPlan.cells?.[0]?.storageChecks?.length !== 1 ||
  externalPlan.cells?.[0]?.storageChecks?.[0]?.slot !== externalStorageSlot ||
  externalPlan.capabilities?.length !== 0 ||
  externalPlan.steps?.length !== 0 ||
  externalPlan.requirements?.length !== 0 ||
  externalVerification.status !== "converged" ||
  externalVerification.chains?.[0]?.cells?.[0]?.status?.kind !== "satisfied" ||
  externalVerification.chains?.[0]?.cells?.[0]?.callChecks?.[0]?.status?.kind !== "satisfied" ||
  externalVerification.chains?.[0]?.cells?.[0]?.storageChecks?.[0]?.status?.kind !== "satisfied" ||
  externalStorageDrift.status !== "drifted" ||
  externalStorageDrift.chains?.[0]?.cells?.[0]?.storageChecks?.[0]?.status?.kind !== "drifted" ||
  externalStorageDrift.chains?.[0]?.cells?.[0]?.storageChecks?.[0]?.status?.observedWord !==
    externalDriftWord ||
  externalStorageUnreadable.status !== "unreadable" ||
  externalStorageUnreadable.chains?.[0]?.cells?.[0]?.storageChecks?.[0]?.status?.kind !==
    "unreadable" ||
  externalCheckDrift.status !== "drifted" ||
  externalCheckDrift.chains?.[0]?.cells?.[0]?.callChecks?.[0]?.status?.kind !== "drifted" ||
  externalCheckDrift.chains?.[0]?.cells?.[0]?.callChecks?.[0]?.status?.observedResult !==
    externalDriftResult ||
  externalCheckUnreadable.status !== "unreadable" ||
  externalCheckUnreadable.chains?.[0]?.cells?.[0]?.callChecks?.[0]?.status?.kind !==
    "unreadable" ||
  externalRuntimeDrift.status !== "drifted" ||
  externalRuntimeDrift.chains?.[0]?.cells?.[0]?.status?.kind !== "drifted" ||
  externalRuntimeDrift.chains?.[0]?.cells?.[0]?.status?.observedRuntimeCodeHash !==
    externalDriftRuntimeHash ||
  codeTargets.length !== 7 ||
  codeTargets.some((target) => target !== externalAddress) ||
  externalCallParams.length !== 5 ||
  externalCallParams.some(
    (params) =>
      params?.length !== 2 || JSON.stringify(params) !== JSON.stringify(expectedExternalCallParams),
  ) ||
  externalStorageParams.length !== 6 ||
  externalStorageParams.some(
    (params) =>
      params?.length !== 3 ||
      JSON.stringify(params) !== JSON.stringify(expectedExternalStorageParams),
  )
) {
  throw new Error("packed exact-address external check API smoke failed");
}

externalCode = externalRuntime;
externalCallMode = "satisfied";
externalStorageMode = "satisfied";
codeTargets.length = 0;
externalCallParams.length = 0;
externalStorageParams.length = 0;
const managedAttestationPlan = await moesi.plan({
  chains: [1],
  manifest: {
    version: "moesi.manifest/v5",
    contracts: [{
      kind: "managed",
      id: "attested",
      deployment: {
        kind: "create2-factory-v1",
        requiresRuntime: [],
        salt: bytes32("f"),
        initCode: "0x6000",
        value: "0",
      },
      expectedRuntimeCodeHash: resourceRuntimeHash,
      checks: [{
        id: "owner",
        caller: externalCaller,
        readData: externalReadData,
        expectedResult: externalExpectedResult,
      }],
      storageChecks: [{
        id: "marker",
        slot: externalStorageSlot,
        expectedWord: externalExpectedWord,
      }],
      configuration: [],
    }],
  },
});
const managedAttestationVerification = await moesi.verify({ plan: managedAttestationPlan });
externalCallMode = "drifted";
const managedCallDrift = await moesi.verify({ plan: managedAttestationPlan });
externalCallMode = "satisfied";
externalStorageMode = "drifted";
const managedStorageDrift = await moesi.verify({ plan: managedAttestationPlan });
externalStorageMode = "satisfied";
const managedAddress = managedAttestationPlan.cells[0]?.address;
const expectedManagedCallParams = [
  { from: externalCaller, to: managedAddress, data: externalReadData },
  { blockHash: bytes32("2"), requireCanonical: true },
];
const expectedManagedStorageParams = [
  managedAddress,
  externalStorageSlot,
  { blockHash: bytes32("2"), requireCanonical: true },
];
if (
  managedAttestationPlan.disposition !== "converged" ||
  managedAttestationPlan.steps.length !== 0 ||
  managedAttestationPlan.requirements.length !== 0 ||
  managedAttestationPlan.cells[0]?.configuration.length !== 0 ||
  managedAttestationPlan.cells[0]?.checks[0]?.id !== "owner" ||
  managedAttestationPlan.cells[0]?.storageChecks[0]?.id !== "marker" ||
  managedAttestationVerification.status !== "converged" ||
  managedAttestationVerification.chains[0]?.cells[0]?.callChecks[0]?.status.kind !== "satisfied" ||
  managedAttestationVerification.chains[0]?.cells[0]?.storageChecks[0]?.status.kind !==
    "satisfied" ||
  managedAttestationVerification.chains[0]?.cells[0]?.configurations.length !== 0 ||
  managedCallDrift.status !== "drifted" ||
  managedCallDrift.chains[0]?.cells[0]?.callChecks[0]?.status.observedResult !==
    externalDriftResult ||
  managedStorageDrift.status !== "drifted" ||
  managedStorageDrift.chains[0]?.cells[0]?.storageChecks[0]?.status.observedWord !==
    externalDriftWord ||
  codeTargets.length !== 4 ||
  codeTargets.some((target) => target !== managedAddress) ||
  externalCallParams.length !== 4 ||
  externalCallParams.some(
    (params) => JSON.stringify(params) !== JSON.stringify(expectedManagedCallParams),
  ) ||
  externalStorageParams.length !== 4 ||
  externalStorageParams.some(
    (params) => JSON.stringify(params) !== JSON.stringify(expectedManagedStorageParams),
  )
) {
  throw new Error("packed managed read-only attestation API smoke failed");
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

function assertCanonicalPackage(packageJson, expectedName) {
  if (
    packageJson.name !== expectedName ||
    typeof packageJson.version !== "string" ||
    !/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(packageJson.version)
  ) {
    throw new Error(`${expectedName} source manifest is not a canonical 0.x.y package`);
  }
}

function assertCorePackedContents(tarball) {
  const entries = packedEntries(tarball, "moesi");
  const internal = entries.filter((entry) => /^dist\/internal-[A-Za-z0-9_-]+\.js$/.test(entry));
  const provider = entries.filter((entry) => /^dist\/provider-[A-Za-z0-9_-]+\.d\.ts$/.test(entry));
  if (internal.length !== 1 || provider.length !== 1) {
    throw new Error("packed moesi has unexpected generated chunk names");
  }
  const expected = [
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
    provider[0],
    "dist/viem/index.d.ts",
    "dist/viem/index.js",
    "dist/viem/index.js.map",
    "package.json",
  ].sort(compareAscii);
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error(`packed moesi contains unexpected files: ${entries.join(", ")}`);
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
