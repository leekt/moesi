import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  key,
  loadFleetObservation,
  nextAttempt,
  SqliteFleetObservationStore,
  scan,
} from "./compiled/fleet-observation.js";

const path = join(process.cwd(), "observations.sqlite");
const mode = process.argv[2];
if (mode === "race") {
  const store = new SqliteFleetObservationStore({ path });
  try {
    const before = await loadFleetObservation(store, key);
    const go = once(process, "message");
    process.send({ type: "ready" });
    await go;
    const won = await store.compareAndSwap(nextAttempt(before), before.revision);
    process.send({ type: "result", won });
  } finally {
    store.close();
    process.disconnect();
  }
} else if (mode === "crash") {
  const store = new SqliteFleetObservationStore({ path });
  // Keep the child alive after it has durably reserved its pending attempt.
  setInterval(() => {}, 1000);
  await scan(store, async () => {
    process.send({ type: "pending" });
    await new Promise(() => {});
  });
} else {
  const store = new SqliteFleetObservationStore({ path });
  const children = [];
  try {
    const first = await scan(store);
    assert.equal(first.record.state, "complete");
    const start = (mode) => {
      const child = fork(fileURLToPath(import.meta.url), [mode], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      children.push(child);
      return child;
    };
    const left = start("race");
    const leftReady = once(left, "message");
    const leftExit = once(left, "exit");
    const right = start("race");
    const rightReady = once(right, "message");
    const rightExit = once(right, "exit");
    await Promise.all([leftReady, rightReady]);
    const leftResult = once(left, "message");
    const rightResult = once(right, "message");
    left.send("go");
    right.send("go");
    const results = await Promise.all([leftResult, rightResult]);
    assert.equal(results.filter(([result]) => result.won).length, 1);
    assert.deepEqual(await Promise.all([leftExit, rightExit]), [
      [0, null],
      [0, null],
    ]);
    const retained = await loadFleetObservation(store, key);
    assert.equal(retained.revision, first.record.revision + 1);
    assert.deepEqual(retained.snapshot, first.record.snapshot);
    const child = start("crash");
    const killed = once(child, "exit");
    assert.equal((await once(child, "message"))[0].type, "pending");
    child.kill("SIGKILL");
    await killed;
    store.close();
    const reopened = new SqliteFleetObservationStore({ path });
    try {
      const offline = await loadFleetObservation(reopened, key);
      assert.equal(offline.state, "pending");
      assert.deepEqual(offline.snapshot, first.record.snapshot);
      assert.equal((await scan(reopened)).record.state, "complete");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
