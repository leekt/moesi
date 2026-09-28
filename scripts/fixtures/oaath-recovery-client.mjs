import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openLocalAnvilRecoveryClient } from "@oaath/testing/anvil";

// Only the public upstream fixture owns persistence and read-only SDK composition.
export async function openOAAth() {
  const stateDirectory = process.env.MOESI_PROCESS_STATE;
  const recovery = JSON.parse(await readFile(join(stateDirectory, "recovery.json"), "utf8"));
  return { oaath: await openLocalAnvilRecoveryClient({ recovery, stateDirectory }) };
}
