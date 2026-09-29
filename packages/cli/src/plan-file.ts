import { link, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./errors.js";

/** Publish a complete artifact atomically without replacing existing reviewed work. */
export async function writePlanFile(path: string, source: string): Promise<void> {
  let temporary: string | undefined;
  try {
    const destination = resolve(path);
    temporary = await mkdtemp(join(dirname(destination), ".moesi-plan-"));
    const staged = join(temporary, "plan.json");
    const file = await open(staged, "wx", 0o600);
    try {
      await file.writeFile(source, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await link(staged, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError("plan_output_exists", "plan output already exists");
    }
    throw new CliError("plan_write_failed", "plan output could not be written");
  } finally {
    // Once published, cleanup failure must not falsely report an unsaved plan.
    if (temporary !== undefined)
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
