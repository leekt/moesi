import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePlanFile } from "../src/plan-file.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "moesi-plan-output-"));
  directories.push(directory);
  return { directory, path: join(directory, "plan.json") };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("saved plan publication", () => {
  it("publishes one complete private file and refuses to replace reviewed work", async () => {
    const { directory, path } = await fixture();
    await writePlanFile(path, "first reviewed artifact\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(writePlanFile(path, "replacement\n")).rejects.toMatchObject({
      code: "plan_output_exists",
    });
    expect(await readFile(path, "utf8")).toBe("first reviewed artifact\n");
    expect(await readdir(directory)).toEqual(["plan.json"]);
  });

  it("allows exactly one concurrent writer and preserves its complete output", async () => {
    const { path } = await fixture();
    const sources = ["a".repeat(128_000), "b".repeat(128_000)];
    const results = await Promise.allSettled(sources.map((source) => writePlanFile(path, source)));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const winner = results.findIndex(({ status }) => status === "fulfilled");
    expect(await readFile(path, "utf8")).toBe(sources[winner]);
    expect(results[1 - winner]).toMatchObject({
      status: "rejected",
      reason: { code: "plan_output_exists" },
    });
  });

  it("does not follow an existing output symlink or overwrite its target", async () => {
    const { directory, path } = await fixture();
    const target = join(directory, "manifest.json");
    await writeFile(target, "original manifest");
    await symlink(target, path);
    await expect(writePlanFile(path, "artifact")).rejects.toMatchObject({
      code: "plan_output_exists",
    });
    expect(await readFile(target, "utf8")).toBe("original manifest");
  });

  it("reports a missing parent without retaining raw filesystem diagnostics", async () => {
    const { directory } = await fixture();
    await expect(
      writePlanFile(join(directory, "private-path", "plan.json"), "artifact"),
    ).rejects.toMatchObject({
      code: "plan_write_failed",
      message: "plan output could not be written",
    });
    expect(await readdir(directory)).toEqual([]);
  });
});
