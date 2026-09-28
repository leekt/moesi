import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// An allowlist also removes unfamiliar provider keys, URLs and runtime preloads.
const TOOLCHAIN_ENV = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PNPM_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CI",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "TZ",
]);

export function scrubLiveRpcEnv(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => TOOLCHAIN_ENV.has(key) && typeof value === "string",
    ),
  );
}

/** For standalone repository scripts invoked directly by CI. */
export function scrubCurrentProcessEnv() {
  const clean = scrubLiveRpcEnv(process.env);
  for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write("test_environment_command_required\n");
    process.exitCode = 1;
  } else {
    const child = spawn(command, args, { stdio: "inherit", env: scrubLiveRpcEnv(process.env) });
    const forward = (signal) => child.kill(signal);
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", () => {
      process.stderr.write("test_environment_command_failed\n");
      process.exitCode = 1;
    });
    child.once("close", (code, signal) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
    });
  }
}
