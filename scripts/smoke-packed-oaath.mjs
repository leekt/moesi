import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfies } from "semver";
import { scrubCurrentProcessEnv } from "./scrub-live-rpc-env.mjs";

scrubCurrentProcessEnv();

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "moesi-packed-oaath-"));
const env = Object.fromEntries(
  ["PATH", "HOME", "PNPM_HOME", "TMPDIR"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0 || result.error) {
    // Consumer catches raw SDK failures; only its bounded stage code is safe.
    if (command === process.execPath && /^packed_oaath_[a-z_]+\n$/.test(result.stderr ?? ""))
      process.stderr.write(result.stderr);
    throw new Error("packed_oaath_command_failed");
  }
}
try {
  const dependencies = {
    viem: "2.55.8",
    typescript: "7.0.2",
    solc: "0.8.30",
    "fake-indexeddb": "6.2.5",
  };
  const overrides = {};
  const provenance = JSON.parse(await readFile(join(root, "vendor/oaath/provenance.json"), "utf8"));
  for (const [name, expected] of Object.entries(provenance.sha256)) {
    const source = join(root, "vendor/oaath", name);
    if (
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex") !== expected
    )
      throw new Error("oaath_artifact_checksum_mismatch");
    await copyFile(source, join(temporary, name));
    const packed = spawnSync("tar", ["-xOzf", source, "package/package.json"], {
      encoding: "utf8",
      env,
    });
    if (packed.status !== 0) throw new Error("oaath_artifact_invalid");
    const manifest = JSON.parse(packed.stdout);
    overrides[manifest.name] = `file:${join(temporary, name)}`;
    dependencies[manifest.name] = overrides[manifest.name];
  }
  for (const directory of ["moesi", "oaath-adapter", "cli"]) {
    const path = join(root, "packages", directory);
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    run("pnpm", ["pack", "--pack-destination", temporary], path);
    const tarball = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
    dependencies[manifest.name] = `file:${join(temporary, tarball)}`;
    overrides[manifest.name] = dependencies[manifest.name];
  }
  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "moesi-packed-oaath", private: true, type: "module", dependencies }),
  );
  await writeFile(
    join(consumer, "pnpm-workspace.yaml"),
    `overrides:\n${Object.entries(overrides)
      .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join("\n")}\n`,
  );
  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], consumer);
  const installed = new Map();
  for (const name of [
    "moesi",
    "@moesi/oaath",
    "@moesi/cli",
    "@oaath/protocol",
    "@oaath/sdk",
    "@oaath/server",
    "@oaath/testing",
  ])
    installed.set(
      name,
      JSON.parse(await readFile(join(consumer, "node_modules", name, "package.json"), "utf8")),
    );
  const core = installed.get("moesi");
  const adapter = installed.get("@moesi/oaath");
  const cli = installed.get("@moesi/cli");
  const sdk = installed.get("@oaath/sdk");
  if (
    !/^0\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(core.version) ||
    adapter.version !== core.version ||
    cli.version !== core.version ||
    cli.dependencies.moesi !== core.version ||
    !satisfies(core.version, adapter.peerDependencies.moesi) ||
    !satisfies(adapter.version, cli.peerDependencies["@moesi/oaath"]) ||
    cli.peerDependenciesMeta["@moesi/oaath"].optional !== true ||
    adapter.peerDependencies["@oaath/sdk"] !== sdk.version
  )
    throw new Error("packed_oaath_release_coordinates_invalid");
  for (const [name, manifest] of installed) {
    if (name.startsWith("@oaath/")) {
      if (manifest.version !== sdk.version) throw new Error("packed_oaath_fixed_group_invalid");
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {}))
        if (dependency.startsWith("@oaath/") && version !== sdk.version)
          throw new Error("packed_oaath_internal_version_invalid");
    }
  }
  await copyFile(join(root, "scripts/fixtures/oaath-consumer.mjs"), join(consumer, "index.mjs"));
  await writeFile(
    join(consumer, "surface.ts"),
    `import { createOAAth, type Oaath, type OaathOwnerClient, type OaathLocalConfiguration } from "@oaath/sdk";
import { createWalletClient, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { compileCheckedBeaconProxy, type CheckedBeaconProxyInput, type CompiledCheckedBeaconProxy, type MoesiExecutionProvider, type ReviewedPlan, type SemanticCheck, type ReviewedExecution, compileExecutionOperations, type ExecutionPacking } from "moesi";
import { parseManifest, type MoesiManifest, type ResolvedMoesiManifest, type ManifestBytes, type MoesiClient, type MoesiDiscoverRequest, type MoesiDiscoveryResult } from "moesi";
import { createOAAthExecutionProvider, compileOAAthPlanPermission, requestOAAthPlanPermission } from "@moesi/oaath";
import { createViemObserver, type CreateViemObserverInput } from "moesi/viem";
export function observe(input: CreateViemObserverInput) { return createViemObserver(input); }
export function packing(plan: ReviewedPlan, review: ReviewedExecution) { const p: ExecutionPacking = review.packing; return compileExecutionOperations(plan, p); }
export function compose(oaath: Oaath): MoesiExecutionProvider { return createOAAthExecutionProvider({ oaath }); }
export function composeLocal(chains: OaathLocalConfiguration["chains"], address: Address, url: string): MoesiExecutionProvider {
  const owner = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), transport: http(url) });
  const oaath = createOAAth({ mode: "local", account: { kind: "existing", address }, owner, chains, origin: "https://consumer.example" });
  return createOAAthExecutionProvider({ oaath, account: { kind: "existing", address }, owner, signer: "session" });
}
export function composeOwner(oaath: OaathOwnerClient, address: Address, url: string): MoesiExecutionProvider {
  const owner = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), transport: http(url) });
  return createOAAthExecutionProvider({ oaath, account: { kind: "existing", address }, owner, signer: "auto", sender: "auto" });
}
export function authorize(oaath: Oaath, plan: ReviewedPlan) { compileOAAthPlanPermission({ plan }); return requestOAAthPlanPermission({ oaath, plan }); }
export function resolve(manifest: MoesiManifest): ResolvedMoesiManifest { return parseManifest(manifest); }
export function discover(client: MoesiClient, request: MoesiDiscoverRequest): Promise<MoesiDiscoveryResult> { return client.discover(request); }
export function beacon(input: CheckedBeaconProxyInput): CompiledCheckedBeaconProxy { return compileCheckedBeaconProxy(input); }
export function ownership(caller: Address): SemanticCheck { return { kind: "ownable-owner", id: "owner", caller, expectedOwner: caller }; }
export const reference: ManifestBytes = { kind: "concat", parts: ["0x12345678", { kind: "resource-address-word", resourceId: "registry" }] };
`,
  );
  run(
    "pnpm",
    [
      "exec",
      "tsc",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "surface.ts",
    ],
    consumer,
  );
  await copyFile(
    join(root, "packages/moesi/test/fixtures/Configurable.sol"),
    join(consumer, "Configurable.sol"),
  );
  run(process.execPath, ["index.mjs"], consumer);
  run(process.execPath, ["index.mjs", "0.3.3"], consumer);
  await copyFile(
    join(root, "scripts/fixtures/oaath-owner-consumer.mjs"),
    join(consumer, "oaath-owner-consumer.mjs"),
  );
  run(process.execPath, ["oaath-owner-consumer.mjs"], consumer);
  run(process.execPath, ["oaath-owner-consumer.mjs", "local-session"], consumer);
  await copyFile(
    join(root, "packages/moesi/test/fixtures/CreateX.runtime.hex"),
    join(consumer, "CreateX.runtime.hex"),
  );
  await copyFile(
    join(root, "scripts/fixtures/oaath-createx-consumer.mjs"),
    join(consumer, "oaath-createx-consumer.mjs"),
  );
  run(process.execPath, ["oaath-createx-consumer.mjs"], consumer);
  for (const filename of [
    "oaath-cli-client.mjs",
    "oaath-cli-consumer.mjs",
    "oaath-recovery-client.mjs",
    "oaath-process-consumer.mjs",
    "oaath-owner-cli-client.mjs",
    "oaath-owner-cli-consumer.mjs",
  ])
    await copyFile(join(root, "scripts/fixtures", filename), join(consumer, filename));
  run(process.execPath, ["oaath-cli-consumer.mjs"], consumer);
  run(process.execPath, ["oaath-owner-cli-consumer.mjs"], consumer);
  run(process.execPath, ["oaath-process-consumer.mjs"], consumer);
  process.stdout.write(
    "packed OAAth adapter: library + CLI, v4/v3.3 and issuer-free local sessions with one approval, silent repairs and revocation, atomic cold deploy/configure, Kernel v3.3 browser/local owners, bundler and conclusive-rejection fallback, protected CREATE2/CREATE3, exact calls, recreated SDKs and OS processes, zero resubmission, convergence\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
