import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkNoAaImplementation, checkOaathBoundary } from "./boundary-policy.mjs";
import { scrubLiveRpcEnv } from "./scrub-live-rpc-env.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "moesi-boundary-"));
  async function put(path, content) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  const core = { name: "moesi", dependencies: { viem: "2.55.8" } };
  const adapter = {
    name: "@moesi/oaath",
    peerDependencies: { moesi: "0.13.x", "@oaath/sdk": "0.1.0" },
  };
  const cli = {
    name: "@moesi/cli",
    dependencies: { moesi: "workspace:*" },
    peerDependencies: { "@moesi/oaath": "0.13.x" },
    peerDependenciesMeta: { "@moesi/oaath": { optional: true } },
  };
  try {
    await put("package.json", { private: true, workspaces: ["packages/*"] });
    await put("packages/moesi/package.json", core);
    await put("packages/oaath-adapter/package.json", adapter);
    await put("packages/cli/package.json", cli);
    await run({ root, put, core, adapter, cli });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("permits public contracts, ordinary viem, and the explicit CLI client module", async () =>
  fixture(async ({ root, put }) => {
    await put(
      "packages/moesi/src/index.ts",
      'import { createWalletClient } from "viem"; export { createWalletClient };',
    );
    await put(
      "packages/oaath-adapter/src/index.ts",
      'import type { Oaath } from "@oaath/sdk"; import type { ReviewedPlan } from "moesi";',
    );
    await put(
      "packages/cli/src/oaath-runtime.ts",
      'await import("@moesi/oaath"); await import(pathToFileURL(resolve(clientModule)).href);',
    );
    await put(
      "scripts/fixtures/client.mjs",
      'import { createLocalAnvilFixture } from "@oaath/testing/anvil";',
    );
    await checkOaathBoundary(root);
    await checkNoAaImplementation(root);
  }));

const rejectedSources = [
  [
    "packages/moesi/src/nested/index.ts",
    'export * from "@oaath/sdk";',
    "boundary_oaath_import_forbidden",
  ],
  [
    "packages/cli/src/client.ts",
    'import type { Oaath } from "@oaath/sdk";',
    "boundary_oaath_import_forbidden",
  ],
  [
    "packages/oaath-adapter/src/provider.ts",
    'await import("@oaath/sdk/internal");',
    "boundary_oaath_import_forbidden",
  ],
  [
    "packages/oaath-adapter/src/provider.ts",
    'import { x } from "@oaath/sdk/\\u0073rc/private";',
    "boundary_oaath_import_forbidden",
  ],
  [
    "packages/oaath-adapter/src/provider.ts",
    'type Hidden = import("@oaath/protocol").Hidden;',
    "boundary_oaath_import_forbidden",
  ],
  [
    "packages/oaath-adapter/src/provider.ts",
    'const sdk = require("@oaath/sdk/dist/index.js");',
    "boundary_oaath_import_forbidden",
  ],
  [
    "packages/oaath-adapter/src/provider.ts",
    'import sdk = require("@oaath/sdk/internal");',
    "boundary_oaath_import_forbidden",
  ],
  [
    "packages/moesi/src/nested/index.ts",
    'import x from "../../../../../oaath/packages/sdk/src/index.js";',
    "boundary_source_escape_forbidden",
  ],
  [
    "packages/moesi/src/index.ts",
    'import x from "../../oaath-adapter/src/index.js";',
    "boundary_source_escape_forbidden",
  ],
  [
    "packages/oaath-adapter/src/provider.ts",
    'import x from "moesi/dist/index.js";',
    "boundary_moesi_internal_import",
  ],
  [
    "packages/oaath-adapter/src/provider.ts",
    'import x from "moesi/viem";',
    "boundary_adapter_direct_provider_import",
  ],
  [
    "scripts/fixtures/client.mjs",
    'import x from "../../packages/moesi/src/index.js";',
    "boundary_consumer_source_import_forbidden",
  ],
  [
    "packages/cli/src/oaath-runtime.ts",
    'import { x } from "@moesi/oaath";',
    "boundary_cli_adapter_import_forbidden",
  ],
  [
    "packages/moesi/src/index.ts",
    "await import(packageName);",
    "boundary_computed_import_forbidden",
  ],
  [
    "packages/moesi/src/index.ts",
    'import x from "../node_modules/@oaath/sdk/dist/index.js";',
    "boundary_private_path_import_forbidden",
  ],
  [
    "packages/moesi/src/index.cjs",
    'module.require("@oaath/sdk");',
    "boundary_oaath_import_forbidden",
  ],
  [
    "packages/moesi/src/index.cjs",
    'module["require"]("@oaath/sdk");',
    "boundary_oaath_import_forbidden",
  ],
  [
    "packages/moesi/src/index.ts",
    'import { createRequire } from "node:module";',
    "boundary_dynamic_loader_forbidden",
  ],
  [
    "packages/moesi/src/index.ts",
    'await import("file:///private/source.mjs");',
    "boundary_absolute_import_forbidden",
  ],
  [
    "packages/moesi/src/index.ts",
    'import x from "viem/account-abstraction";',
    "boundary_aa_import_forbidden",
  ],
];
for (const [path, source, code] of rejectedSources)
  test(`${code}: ${source}`, async () =>
    fixture(async ({ root, put }) => {
      await put(path, source);
      await assert.rejects(checkOaathBoundary(root), { message: code });
    }));

test("rejects dependency aliases, git sources, core OAAth dependencies and broad workspaces", async () =>
  fixture(async ({ root, put, core }) => {
    for (const dependencies of [
      { alias: "npm:@oaath/sdk@0.1.0" },
      { other: "git+https://example.invalid/repo" },
      { "@oaath/sdk": "0.1.0" },
    ]) {
      await put("packages/moesi/package.json", { ...core, dependencies });
      await assert.rejects(
        checkOaathBoundary(root),
        /boundary_(?:dependency_source|oaath_dependency)_forbidden/,
      );
    }
    await put("packages/moesi/package.json", core);
    await put("package.json", { private: true, workspaces: ["packages/*", "../oaath/packages/*"] });
    await assert.rejects(checkOaathBoundary(root), {
      message: "boundary_workspace_layout_invalid",
    });
  }));

test("rejects source symlinks and submodules", async () =>
  fixture(async ({ root, put }) => {
    await symlink(tmpdir(), join(root, "external-source"));
    await assert.rejects(checkOaathBoundary(root), { message: "boundary_symlink_forbidden" });
    await rm(join(root, "external-source"));
    await put(".gitmodules", "[submodule]\n");
    await assert.rejects(checkOaathBoundary(root), { message: "boundary_submodule_forbidden" });
  }));

test("rejects repository shorthand and local directory dependency sources", async () =>
  fixture(async ({ root, put, adapter }) => {
    for (const version of [
      "leekt/oaath",
      "gitlab:leekt/oaath",
      "bitbucket:leekt/oaath",
      "../oaath",
      "/private/oaath",
      "",
      "workspace:../oaath",
    ]) {
      await put("packages/oaath-adapter/package.json", {
        ...adapter,
        devDependencies: { "@oaath/sdk": version },
      });
      await assert.rejects(checkOaathBoundary(root), {
        message: "boundary_dependency_source_forbidden",
      });
    }
  }));

test("rejects imports into ignored generated directories", async () =>
  fixture(async ({ root, put }) => {
    for (const directory of ["dist", "coverage", ".artifacts"]) {
      await put(`packages/moesi/${directory}/copied.js`, "export function signUserOperation() {};");
      await put("packages/moesi/src/index.ts", `export * from "../${directory}/copied.js";`);
      await assert.rejects(checkOaathBoundary(root), {
        message: "boundary_ignored_source_import_forbidden",
      });
    }
  }));

test("rejects workspace aliases and duplicate declarations", async () =>
  fixture(async ({ root, put }) => {
    await put("package.json", {
      workspaces: ["packages/*"],
      overrides: { "@oaath/sdk": "npm:@oaath/protocol@0.1.0" },
    });
    await assert.rejects(checkOaathBoundary(root), { message: "boundary_tarball_path_forbidden" });
    await put("package.json", '{"workspaces":["packages/*"],"workspaces":["../oaath"]}');
    await assert.rejects(checkOaathBoundary(root), {
      message: "boundary_workspace_layout_invalid",
    });
  }));

test("allows only checksummed local SDK tarballs", async () =>
  fixture(async ({ root, put, adapter }) => {
    const name = "oaath-sdk-0.1.0.tgz";
    await put(`vendor/oaath/${name}`, "fixture bytes");
    await put("vendor/oaath/provenance.json", {
      sha256: { [name]: createHash("sha256").update("fixture bytes").digest("hex") },
    });
    await put("packages/oaath-adapter/package.json", {
      ...adapter,
      devDependencies: { "@oaath/sdk": `file:../../vendor/oaath/${name}` },
    });
    await put("package.json", {
      workspaces: ["packages/*"],
      overrides: { "@oaath/sdk": `file:vendor/oaath/${name}` },
    });
    await checkOaathBoundary(root);
    await put(`vendor/oaath/${name}`, "changed");
    await assert.rejects(checkOaathBoundary(root), {
      message: "boundary_tarball_checksum_mismatch",
    });
  }));

test("rejects alternative workspace configuration and unchecked resolution overrides", async () =>
  fixture(async ({ root, put, core }) => {
    for (const manifest of [
      { workspaces: { packages: ["packages/*"] } },
      { workspaces: ["packages/*"], overrides: [] },
      { workspaces: ["packages/*"], overrides: { "@oaath/sdk": { version: "0.2.0" } } },
      { workspaces: ["packages/*"], resolutions: { "@oaath/sdk": "../oaath" } },
    ]) {
      await put("package.json", manifest);
      await assert.rejects(checkOaathBoundary(root), {
        message: "boundary_workspace_layout_invalid",
      });
    }
    await put("package.json", { workspaces: ["packages/*"] });
    for (const field of ["workspaces", "overrides", "resolutions"]) {
      await put("packages/moesi/package.json", { ...core, [field]: {} });
      await assert.rejects(checkOaathBoundary(root), {
        message: "boundary_workspace_layout_invalid",
      });
    }
  }));

for (const source of [
  "function signUserOperation() {}",
  'const client = { "eth_sendUserOperation": () => {} };',
  'const abi = [{ name: "handleOps" }];',
  "class KernelAccount {}",
  "const generated = `function signUserOperation() {}`;",
])
  test(`rejects AA implementation: ${source}`, async () =>
    fixture(async ({ root, put }) => {
      await put("packages/moesi/src/hidden.ts", source);
      await assert.rejects(checkNoAaImplementation(root), {
        message: "boundary_aa_implementation_forbidden",
      });
    }));

test("test child environment discards unknown credentials and preload settings", () => {
  const marker = "test-only-private-value";
  const input = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CI: "true",
    ALCHEMY_API_KEY: marker,
    RPC_URL: marker,
    UNKNOWN_PROVIDER_SECRET: marker,
    PRIVATE_KEY: marker,
    NODE_OPTIONS: "--no-warnings",
    DYLD_LIBRARY_PATH: marker,
    npm_config_registry: marker,
  };
  const clean = scrubLiveRpcEnv(input);
  assert.deepEqual(Object.keys(clean).sort(), ["CI", "HOME", "PATH"]);
  const wrapper = fileURLToPath(new URL("./scrub-live-rpc-env.mjs", import.meta.url));
  const child = spawnSync(
    process.execPath,
    [
      wrapper,
      process.execPath,
      "-e",
      "if (Object.keys(process.env).some(k => /RPC|SECRET|PRIVATE|ALCHEMY|NODE_OPTIONS|DYLD|npm_config/.test(k))) process.exit(1);",
    ],
    { env: input, encoding: "utf8" },
  );
  assert.equal(child.status, 0);
  assert.equal(child.stdout + child.stderr, "");
  const failed = spawnSync(process.execPath, [wrapper, process.execPath, "-e", "process.exit(7)"], {
    env: clean,
    encoding: "utf8",
  });
  assert.equal(failed.status, 7);
});

test("standalone packed/onchain entrypoints scrub inherited environments", async () => {
  for (const name of [
    "smoke-packed-library",
    "smoke-packed-cli",
    "smoke-packed-oaath",
    "test-cli-anvil",
    "test-packed-anvil",
    "run-examples",
  ]) {
    const source = await readFile(new URL(`./${name}.mjs`, import.meta.url), "utf8");
    assert.match(source, /scrubCurrentProcessEnv\(\);/);
  }
});
