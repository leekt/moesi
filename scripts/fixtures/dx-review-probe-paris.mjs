// Dated capability-probe review against local Anvil, never a shared RPC.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { runFeatureProbe } from "moesi";
import { createPublicClient, http } from "viem";

const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const node = spawn("anvil", ["--silent", "--hardfork", "paris", "--port", String(port)], {
  stdio: "ignore",
  env: { PATH: process.env.PATH ?? "" },
});
const stopped = once(node, "exit");
try {
  const client = createPublicClient({
    transport: http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 500 }),
  });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (node.exitCode !== null) throw new Error("local Anvil stopped before readiness");
    try {
      await client.getChainId();
      ready = true;
      break;
    } catch {
      await setTimeout(100);
    }
  }
  if (!ready) throw new Error("local Anvil did not become ready");
  console.log(
    JSON.stringify(
      {
        sourceCommit: "f45aad8e5b1c02e2e31af4c389e77ac3bdd43903",
        hardfork: "paris",
        anvilVersion: spawnSync("anvil", ["--version"], { encoding: "utf8" }).stdout.trim(),
        feature: "eip7702",
        result: await runFeatureProbe(client, "eip7702"),
        interpretation:
          "An estimate with overridden code does not prove authorization-transaction activation.",
      },
      null,
      2,
    ),
  );
} finally {
  node.kill("SIGTERM");
  await stopped;
}
