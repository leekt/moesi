import { runCli } from "./command.js";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch {
  process.stderr.write("MOESI_CLI_ERROR internal\n");
  process.exitCode = 1;
}
