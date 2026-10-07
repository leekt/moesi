import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubCurrentProcessEnv } from "./scrub-live-rpc-env.mjs";

scrubCurrentProcessEnv();
const names = ["minimal-cetane", "minimal-oaath", "multichain-oaath", "drift-repair"];
const selected =
  process.argv[2] === undefined || process.argv[2] === "all" ? names : [process.argv[2]];
if (selected.some((name) => !names.includes(name))) throw new Error("example_name_invalid");
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "moesi-examples-"));
let anvil;
function command(executable, args, cwd, environment = process.env) {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) throw new Error("example_command_failed");
  return result.stdout;
}
try {
  const core = JSON.parse(await readFile(join(root, "packages/moesi/package.json"), "utf8"));
  for (const oaath of [false, true]) {
    const group = selected.filter((name) => name.includes("oaath") === oaath);
    if (group.length === 0) continue;
    const consumer = join(temporary, oaath ? "oaath" : "direct");
    await mkdir(consumer);
    const dependencies = {
      viem: core.devDependencies.viem,
      cetane: `file:${join(root, "vendor/cetane/cetane-0.0.3.tgz")}`,
    };
    const overrides = { cetane: dependencies.cetane };
    for (const directory of oaath ? ["moesi", "oaath-adapter"] : ["moesi"]) {
      const packageRoot = join(root, "packages", directory);
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      command("bun", ["pm", "pack", "--ignore-scripts", "--destination", temporary], packageRoot);
      const tarball = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
      dependencies[manifest.name] = `file:${join(temporary, tarball)}`;
      overrides[manifest.name] = dependencies[manifest.name];
    }
    if (oaath) {
      const provenance = JSON.parse(
        await readFile(join(root, "vendor/oaath/provenance.json"), "utf8"),
      );
      for (const [name, hash] of Object.entries(provenance.sha256)) {
        const source = join(root, "vendor/oaath", name);
        if (
          createHash("sha256")
            .update(await readFile(source))
            .digest("hex") !== hash
        )
          throw new Error("example_artifact_mismatch");
        await copyFile(source, join(temporary, name));
        const manifest = JSON.parse(
          command("tar", ["-xOzf", source, "package/package.json"], root),
        );
        dependencies[manifest.name] = `file:${join(temporary, name)}`;
        overrides[manifest.name] = dependencies[manifest.name];
      }
    }
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "moesi-example-consumer",
        private: true,
        type: "module",
        dependencies,
        overrides,
      }),
    );
    command("bun", ["install", "--prefer-offline", "--ignore-scripts"], consumer);
    await cp(join(root, "examples"), join(consumer, "examples"), { recursive: true });
    await copyFile(
      join(root, `scripts/fixtures/examples-${oaath ? "oaath" : "direct"}.mjs`),
      join(consumer, "main.mjs"),
    );
    let rpcUrl;
    if (!oaath) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = server.address().port;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rpcUrl = `http://127.0.0.1:${port}`;
      anvil = spawn(
        "anvil",
        ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31340", "--silent"],
        { stdio: "ignore" },
      );
      anvil.on("error", () => {});
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        if (anvil.exitCode !== null) break;
        try {
          const response = await fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
            signal: AbortSignal.timeout(250),
          });
          if ((await response.json()).result === "0x7a6c") {
            ready = true;
            break;
          }
        } catch {
          /* The owned loopback process may still be starting. */
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!ready) throw new Error("example_anvil_unavailable");
    }
    const output = command(process.execPath, ["main.mjs", ...group], consumer, {
      ...process.env,
      ...(rpcUrl ? { MOESI_EXAMPLE_RPC: rpcUrl } : {}),
    });
    if (
      !output
        .split("\n")
        .filter(Boolean)
        .every((line) =>
          /^(minimal-cetane|minimal-oaath|multichain-oaath|drift-repair): [a-z0-9 ,;().-]+$/.test(
            line,
          ),
        )
    )
      throw new Error("example_output_invalid");
    process.stdout.write(output);
  }
} finally {
  if (anvil && anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => anvil.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (anvil.exitCode === null && anvil.signalCode === null) anvil.kill("SIGKILL");
  }
  await rm(temporary, { recursive: true, force: true });
}
