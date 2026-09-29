// Dated review evidence, not an evergreen test requiring gaps to remain.
// Copy into a clean consumer of the reviewed moesi/@moesi/cli tarballs.
// Run: node probe.mjs > evidence.json
// No network, wallet, signer, or production state is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as moesi from "moesi";
import {
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  getCreate2Address,
  keccak256,
  stringToHex,
} from "viem";

const hash = (digit) => `0x${digit.repeat(64)}`;
const address = (digit) => `0x${digit.repeat(40)}`;
const runtime = "0x6000";
const managed = {
  kind: "managed",
  id: "resource",
  deployment: {
    kind: "create2-factory-v1",
    salt: hash("b"),
    initCode: "0x6000",
    value: "0",
    requiresRuntime: [],
  },
  expectedRuntimeCodeHash: keccak256(runtime),
  configuration: [
    {
      id: "setting",
      readData: "0x12345678",
      expectedResult: hash("1"),
      writeData: "0x87654321",
      value: "0",
    },
  ],
  checks: [],
  storageChecks: [],
};
const manifest = (resource) => ({
  version: moesi.MOESI_MANIFEST_VERSION,
  contracts: [resource],
});
moesi.parseManifest(manifest(managed));
const results = {};
const parseResult = (input) => {
  try {
    moesi.parseManifest(input);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, code: error.code, path: error.path };
  }
};

// These candidate shapes make missing capabilities concrete; they are not
// proposals to restore the old manifest grammar.
results.protectedCreate3Candidate = parseResult(
  manifest({
    ...managed,
    sender: { kind: "smart-account", accountId: "sra-kernel" },
    deployment: {
      kind: "createx-create3-v1",
      entropy: `0x${"11".repeat(11)}`,
      initCode: "0x6000",
      value: "0",
      requiresRuntime: [],
    },
  }),
);
results.protectedCreate2SmartAccount = parseResult(
  manifest({
    ...managed,
    sender: { kind: "smart-account", accountId: "sra-kernel" },
    deployment: {
      kind: "createx-create2-v1",
      entropy: `0x${"11".repeat(11)}`,
      initCode: "0x6000",
      value: "0",
      requiresRuntime: [],
    },
  }),
);
results.chainScopedResourceCandidate = parseResult(manifest({ ...managed, chains: [1] }));
results.constructorReferenceCandidate = parseResult(
  manifest({
    ...managed,
    deployment: {
      ...managed.deployment,
      initCode: {
        kind: "concat",
        parts: ["0x6000", { kind: "resource-address-word", resourceId: "resource" }],
      },
    },
  }),
);
results.externalConfigurationCandidate = parseResult(
  manifest({
    kind: "external",
    id: "existing-address",
    address: address("a"),
    expectedRuntimeCodeHash: keccak256(runtime),
    checks: [],
    storageChecks: [],
    configuration: managed.configuration,
  }),
);

const observer = {
  async captureSnapshot() {
    return { blockNumber: "1", blockHash: hash("1") };
  },
  async readCode() {
    return runtime;
  },
  async readCall() {
    return hash("0");
  },
  async checkBlockAncestry() {
    return true;
  },
};
const client = moesi.createMoesi({ observer });
const plan = await client.plan({ manifest: manifest(managed), chains: [1, 10] });
assert.equal(plan.steps.length, 2);
assert.deepEqual(plan.steps[0].call, plan.steps[1].call);
results.multichainConfiguration = plan.steps.map((step) => ({
  chainId: step.chainId,
  kind: step.kind,
  data: step.call.data,
  target: step.call.target,
}));
results.clientMethods = Object.keys(client).sort();
results.observationStoreExports = [
  "FileObservationStore",
  "createObservationSnapshot",
  "diffSnapshots",
].filter((name) => name in moesi);
try {
  await moesi
    .createMoesi({
      observer: {
        ...observer,
        async captureSnapshot(chainId) {
          if (chainId === 10) throw new Error("synthetic offline chain");
          return observer.captureSnapshot();
        },
      },
    })
    .plan({ manifest: manifest(managed), chains: [1, 10] });
  results.snapshotFailure = { returnedPlan: true };
} catch (error) {
  results.snapshotFailure = { returnedPlan: false, code: error.code };
}

// SRA's checked-in default TxTwoV4 labels and Kernel identity, using its
// parity-check formula. These are predicted addresses, not live-chain reads.
const sender = "0xc3a56de6dfc1dcef5113927ec09513918e8c44aa";
results.sraCreate3AddressVectors = [];
for (const name of ["AcrossAdapter", "MultiPairChainlinkResolver"]) {
  const label = `${name}TxTwoV4`;
  const entropy = keccak256(stringToHex(label)).slice(0, 24);
  const protectedRawSalt = concatHex([sender, "0x00", entropy]);
  const protectedSalt = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [sender, protectedRawSalt]),
  );
  const proxy = getCreate2Address({
    from: moesi.CREATEX_FACTORY_V1_ADDRESS,
    salt: protectedSalt,
    bytecodeHash: moesi.CREATEX_CREATE3_PROXY_INIT_CODE_HASH,
  });
  const protectedAddress = getContractAddress({ opcode: "CREATE", from: proxy, nonce: 1n });
  const unguardedPlan = await client.plan({
    chains: [1],
    manifest: manifest({
      ...managed,
      configuration: [],
      deployment: {
        kind: "createx-create3-unguarded-v1",
        entropy,
        initCode: "0x6000",
        value: "0",
        requiresRuntime: [],
      },
    }),
  });
  const unguardedAddress = unguardedPlan.cells[0].address;
  assert.notEqual(protectedAddress.toLowerCase(), unguardedAddress);
  results.sraCreate3AddressVectors.push({
    name,
    label,
    entropy,
    protectedAddress,
    unguardedAddress,
  });
}

const cliPackage = JSON.parse(await readFile("node_modules/@moesi/cli/package.json", "utf8"));
const corePackage = JSON.parse(await readFile("node_modules/moesi/package.json", "utf8"));
const cliBin = `node_modules/@moesi/cli/${cliPackage.bin.moesi}`;
results.cli = [];
for (const args of [["--help"], ["plan", "--help"], ["plan", "--out", "unused.json"]]) {
  const child = spawnSync(process.execPath, [cliBin, ...args], {
    encoding: "utf8",
    // No inherited credentials or runtime RPC configuration.
    env: {},
  });
  if (child.error) throw new Error("review CLI process did not start");
  results.cli.push({ args, exitCode: child.status, stderr: child.stderr.trim() });
}
console.log(
  JSON.stringify(
    {
      sourceCommit: "f45aad8e5b1c02e2e31af4c389e77ac3bdd43903",
      coreVersion: corePackage.version,
      cliVersion: cliPackage.version,
      evidenceKind: "offline public-package review probe; no app migration or onchain proof",
      results,
    },
    null,
    2,
  ),
);
