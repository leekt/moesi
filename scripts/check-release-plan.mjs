import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "moesi-release-plan-"));
const statusPath = join(temporaryDirectory, "status.json");
const configPath = join(workspaceRoot, ".changeset", "config.json");
const corePackagePath = join(workspaceRoot, "packages", "moesi", "package.json");
const cliPackagePath = join(workspaceRoot, "packages", "cli", "package.json");
const changesetId = "provider-neutral-replacement";
const expectedSummary =
  "Replace the old deployer APIs with the incompatible provider-neutral Moesi design, without compatibility shims or an OAAth implementation.";
const expectedConfig = {
  $schema: "https://unpkg.com/@changesets/config@3.1.4/schema.json",
  changelog: "@changesets/cli/changelog",
  commit: false,
  fixed: [["moesi", "@moesi/cli"]],
  linked: [],
  access: "public",
  baseBranch: "main",
  updateInternalDependencies: "patch",
  ignore: [],
};

const expectedReleases = [
  {
    name: "@moesi/cli",
    type: "minor",
    oldVersion: "0.12.0",
    newVersion: "0.13.0",
    changesets: [changesetId],
  },
  {
    name: "moesi",
    type: "minor",
    oldVersion: "0.12.0",
    newVersion: "0.13.0",
    changesets: [changesetId],
  },
];

function fail(message) {
  throw new Error(`release plan check failed: ${message}`);
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactDependencies(actual, expected) {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  const actualNames = Object.keys(actual).sort(compareAscii);
  const expectedNames = Object.keys(expected).sort(compareAscii);
  return (
    JSON.stringify(actualNames) === JSON.stringify(expectedNames) &&
    expectedNames.every((name) => actual[name] === expected[name])
  );
}

function normalizeReleases(releases) {
  if (!Array.isArray(releases)) {
    fail("releases must be an array");
  }

  return releases
    .map((release) => ({
      name: release.name,
      type: release.type,
      oldVersion: release.oldVersion,
      newVersion: release.newVersion,
      changesets: release.changesets,
    }))
    .sort((left, right) => compareAscii(left.name, right.name));
}

try {
  const [config, corePackage, cliPackage] = await Promise.all(
    [configPath, corePackagePath, cliPackagePath].map(async (path) =>
      JSON.parse(await readFile(path, "utf8")),
    ),
  );

  if (JSON.stringify(config) !== JSON.stringify(expectedConfig)) {
    fail(`unexpected Changesets config: ${JSON.stringify(config)}`);
  }
  if (corePackage.name !== "moesi" || corePackage.version !== "0.12.0") {
    fail(`unexpected core package coordinates: ${corePackage.name}@${corePackage.version}`);
  }
  if (cliPackage.name !== "@moesi/cli" || cliPackage.version !== "0.12.0") {
    fail(`unexpected CLI package coordinates: ${cliPackage.name}@${cliPackage.version}`);
  }
  if (!hasExactDependencies(corePackage.dependencies, { viem: "2.55.8" })) {
    fail(`unexpected core dependencies: ${JSON.stringify(corePackage.dependencies)}`);
  }
  if (!hasExactDependencies(cliPackage.dependencies, { moesi: "workspace:*", viem: "2.55.8" })) {
    fail(`unexpected CLI dependencies: ${JSON.stringify(cliPackage.dependencies)}`);
  }

  execFileSync("pnpm", ["exec", "changeset", "status", `--output=${statusPath}`], {
    cwd: workspaceRoot,
    stdio: "inherit",
  });

  const status = JSON.parse(await readFile(statusPath, "utf8"));
  const releases = normalizeReleases(status.releases);

  if (JSON.stringify(releases) !== JSON.stringify(expectedReleases)) {
    fail(`unexpected releases: ${JSON.stringify(releases)}`);
  }

  if (!Array.isArray(status.changesets) || status.changesets.length !== 1) {
    fail("exactly one pending changeset is required");
  }

  const [changeset] = status.changesets;
  if (changeset.id !== changesetId) {
    fail(`unexpected changeset id: ${JSON.stringify(changeset.id)}`);
  }
  if (changeset.summary !== expectedSummary) {
    fail(`unexpected changeset summary: ${JSON.stringify(changeset.summary)}`);
  }

  const changesetReleases = changeset.releases
    ?.map(({ name, type }) => ({ name, type }))
    .sort((left, right) => compareAscii(left.name, right.name));
  const expectedChangesetReleases = expectedReleases.map(({ name, type }) => ({
    name,
    type,
  }));

  if (JSON.stringify(changesetReleases) !== JSON.stringify(expectedChangesetReleases)) {
    fail(`unexpected releases in ${changesetId}: ${JSON.stringify(changesetReleases)}`);
  }

  console.log("Release plan verified: moesi and @moesi/cli 0.12.0 -> 0.13.0 (minor).");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
