import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "moesi-release-plan-"));
const names = ["@moesi/cli", "@moesi/oaath", "moesi"];
const version = /^0\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
function requireFact(condition, code) {
  if (!condition) throw new Error(`release_plan_${code}`);
}
try {
  const config = JSON.parse(await readFile(join(root, ".changeset/config.json"), "utf8"));
  requireFact(
    config.access === "public" &&
      config.fixed.length === 1 &&
      JSON.stringify([...config.fixed[0]].sort()) === JSON.stringify(names),
    "fixed_group",
  );
  // Changesets otherwise promotes a minor peer update to 1.0 even when the
  // adapter explicitly supports the group's next 0.x version.
  requireFact(
    config.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH
      ?.onlyUpdatePeerDependentsWhenOutOfRange === true,
    "peer_policy",
  );
  const packages = await Promise.all(
    ["cli", "oaath-adapter", "moesi"].map(async (directory) =>
      JSON.parse(await readFile(join(root, "packages", directory, "package.json"), "utf8")),
    ),
  );
  for (const [index, manifest] of packages.entries()) {
    requireFact(
      manifest.name === names[index] && version.test(manifest.version),
      "package_coordinates",
    );
  }
  requireFact(new Set(packages.map((p) => p.version)).size === 1, "current_versions");
  const statusPath = join(temporary, "status.json");
  execFileSync("pnpm", ["exec", "changeset", "status", `--output=${statusPath}`], {
    cwd: root,
    stdio: "inherit",
  });
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  requireFact(status.changesets.length > 0, "notes_missing");
  requireFact(
    JSON.stringify(status.releases.map((r) => r.name).sort()) === JSON.stringify(names),
    "release_group",
  );
  for (const release of status.releases) {
    requireFact(
      version.test(release.newVersion) && release.type !== "major",
      "requires_explicit_one_zero_decision",
    );
    requireFact(
      release.oldVersion === packages[0].version && release.changesets.length > 0,
      "release_notes",
    );
  }
  requireFact(new Set(status.releases.map((r) => r.newVersion)).size === 1, "next_versions");
  console.log(
    `Release plan verified: all three Moesi packages remain ${status.releases[0].newVersion}.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
