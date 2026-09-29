// Manual, offline acceptance. Copy into a clean packed Moesi consumer and pass
// the original SRA parity cache directory and a new output directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadFleetObservation, observeFleetChain } from "moesi/fleet";
import { SqliteFleetObservationStore } from "moesi/node";

const source = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
assert.notEqual(output, source);
await mkdir(output, { recursive: true });
globalThis.fetch = async () => {
  throw new Error("external_fetch_forbidden");
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const cacheBytes = await readFile(join(source, "observation-cache.json"));
const cache = JSON.parse(cacheBytes);
const pins = new Map(cache.evidence.evidence.map((item) => [item.chainId, item.snapshot]));
const calls = new Map(cache.calls);
const codes = new Map(cache.codes);
const reads = cache.calls
  .filter(([key]) => key.endsWith(":0x313ce567"))
  .map(([key, result]) => {
    const [id, blockHash, address, caller, data] = key.split(":");
    const chainId = Number(id);
    const snapshot = pins.get(chainId);
    assert.equal(snapshot.blockHash, blockHash);
    return { chainId, address, caller, data, result, snapshot };
  });
let codeReads = 0;
let callReads = 0;
let misses = 0;
const exact = (map, key) => {
  if (!map.has(key)) {
    misses++;
    throw new Error("cached_read_missing");
  }
  return map.get(key);
};
const observer = {
  async captureSnapshot(chainId) {
    const pin = pins.get(chainId);
    assert.ok(pin);
    return { blockHash: pin.blockHash, blockNumber: pin.blockNumber };
  },
  async readCode(request) {
    codeReads++;
    return exact(
      codes,
      `${request.chainId}:${request.snapshot.blockHash}:${request.address.toLowerCase()}`,
    );
  },
  async readCall(request) {
    callReads++;
    return exact(
      calls,
      `${request.chainId}:${request.snapshot.blockHash}:${request.target.toLowerCase()}:${request.caller.toLowerCase()}:${request.data.toLowerCase()}`,
    );
  },
  async checkBlockAncestry() {
    throw new Error("ancestry_not_part_of_offline_observation");
  },
};
const inputs = await Promise.all(
  cache.completed.map(async (chainId) => {
    const bytes = await readFile(join(source, "groups", `${chainId}.json`));
    return {
      scope: "sra",
      chainId,
      manifest: JSON.parse(bytes),
      reads,
      manifestFileSha256: sha(bytes),
    };
  }),
);
const store = new SqliteFleetObservationStore({ path: join(output, "observations.sqlite") });
const evidence = [];
try {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (cursor < inputs.length) {
        const input = inputs[cursor++];
        const { record } = await observeFleetChain({
          ...input,
          store,
          observer,
          definitionHash: `0x${input.manifestFileSha256}`,
          prepare: async () => ({ manifest: input.manifest, reads: input.reads }),
        });
        assert.equal(record.state, "complete");
        assert.equal(record.snapshot.plan.disposition, "converged");
        assert.equal(
          record.snapshot.plan.snapshots[0].blockHash,
          pins.get(input.chainId).blockHash,
        );
        evidence.push({
          chainId: input.chainId,
          manifestFileSha256: input.manifestFileSha256,
          manifestHash: record.manifestHash,
          planId: record.snapshot.plan.planId,
          cells: record.snapshot.plan.cells.length,
          configurationRows: record.snapshot.plan.cells.reduce(
            (sum, cell) => sum + cell.configuration.length,
            0,
          ),
          storedReadCount: record.snapshot.reads.length,
          snapshot: record.snapshot.plan.snapshots[0],
        });
      }
    }),
  );
} finally {
  store.close();
}
const reopened = new SqliteFleetObservationStore({ path: join(output, "observations.sqlite") });
try {
  const beforeCounts = [codeReads, callReads];
  for (const input of inputs) {
    const record = await loadFleetObservation(reopened, {
      scope: input.scope,
      chainId: input.chainId,
    });
    assert.equal(record.state, "complete");
    assert.equal(
      record.snapshot.plan.planId,
      evidence.find((item) => item.chainId === input.chainId).planId,
    );
    assert.deepEqual(record.snapshot.reads, reads);
  }
  assert.deepEqual([codeReads, callReads], beforeCounts);
  const first = inputs[0];
  const previous = await loadFleetObservation(reopened, {
    scope: first.scope,
    chainId: first.chainId,
  });
  const failed = await observeFleetChain({
    ...first,
    definitionHash: `0x${first.manifestFileSha256}`,
    prepare: async () => ({ manifest: first.manifest, reads: first.reads }),
    store: reopened,
    observer: {
      ...observer,
      async readCall() {
        throw new Error("synthetic_offline_failure");
      },
    },
  });
  assert.equal(failed.record.state, "failed");
  assert.deepEqual(failed.record.snapshot, previous.snapshot);
  assert.equal(
    failed.record.failure.observation.plan.cells.some((cell) => cell.status.kind === "unreadable"),
    true,
  );
} finally {
  reopened.close();
}
assert.equal(misses, 0);
evidence.sort((left, right) => left.chainId - right.chainId);
const result = {
  version: "moesi.sra-observation-evidence/v1",
  source: cache.evidence.source,
  sourcePinsCapturedAt: cache.evidence.at,
  cacheSha256: sha(cacheBytes),
  fixtureSha256: sha(await readFile(new URL(import.meta.url))),
  externalRpcRequests: 0,
  cacheMisses: misses,
  codeReads,
  callReads,
  chains: evidence.length,
  cells: evidence.reduce((sum, item) => sum + item.cells, 0),
  configurationRows: evidence.reduce((sum, item) => sum + item.configurationRows, 0),
  offlineReload: "matched",
  incompleteScan: "prior-complete-snapshot-retained",
  evidence,
};
await writeFile(join(output, "evidence.json"), `${JSON.stringify(result, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
console.log(
  JSON.stringify({
    chains: result.chains,
    cells: result.cells,
    configurationRows: result.configurationRows,
    cacheMisses: misses,
    externalRpcRequests: 0,
  }),
);
