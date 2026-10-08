# Durable fleet observations

`observeFleetChain` from `moesi/fleet` records one chain's pinned plan and the
exact reads used to compile its manifest. It reserves a revision before compiling or planning
and atomically finishes only that revision. A newer attempt supersedes an older
worker even when completion order or wall clocks disagree. Calls for different
chains are independent; the application can bound their concurrency and report
each chain separately.

```ts
import { loadFleetObservation, observeFleetChain } from "moesi/fleet";
import { SqliteFleetObservationStore } from "moesi/node";

// Create the parent directory first. Keep this database outside served files.
const store = new SqliteFleetObservationStore({ path: "./data/fleet.sqlite" });
try {
  const cached = await loadFleetObservation(store, { scope: "production", chainId: 1 });
  // cached is available without RPC, including after process restart.
  const result = await observeFleetChain({
    scope: "production",
    chainId: 1,
    // Hash the application definition (recipes, routes, fees and identity),
    // excluding credentials and RPC URLs. Keep it stable across live reads.
    definitionHash,
    prepare: async ({ observer, signal }) => {
      const groups = await fleet.compile({ chains: [1], observer, signal });
      const group = groups.find(group => group.chains.includes(1));
      if (!group) throw new Error("chain_excluded");
      return { manifest: group.manifest, reads: group.reads };
    },
    observer,
    store,
    signal: AbortSignal.timeout(60_000),
  });
  // Publish result.record, comparing revisions when applying UI updates.
} finally {
  store.close();
}
```

Return each compiled group's `reads` with its manifest from `prepare`.
Compilation must run inside this callback so an older compilation cannot
reserve a newer revision after another request finishes. For a literal manifest,
return `{ manifest, reads: [] }` from an async callback. The callback receives
the request-bound observer and cancellation signal. The scanner reuses those
exact block hashes for source and peer observations; other chains capture one
pin each. It never substitutes a newer block when an old pin is unavailable.
The codec rejects contradictory pins, duplicate read identities, wrong-chain
plans, malformed plans and incomplete records. It captures immutable input
without invoking accessors and bounds serialized evidence. The application
still owns the relationship between compiler reads and its business rules;
the store cannot establish that an arbitrary supplied read was used by a rule.

Records use `moesi.fleet-observation/v4` and a stable `(scope, chainId)` key:

| State | Meaning |
| --- | --- |
| `pending` | An attempt reserved this revision; its worker may have stopped. |
| `complete` | Required observations were readable. Inspect the plan for drift, missing deployments and pending peers. |
| `failed` | An observation failed or the attempt was cancelled. Safe diagnostics are in `failure`. |

`snapshot` retains the last complete observation during pending and failed
attempts. A failed scan that produced a partial plan retains it separately in
`failure.observation`; unreadable peers and cells remain explicit. Failure
before a plan exists leaves that field null. Changing the desired manifest
updates `definitionHash` immediately. The retained snapshot carries its own
`definitionHash`; a mismatch means it belongs to another desired definition.
`manifestHash` remains null until compilation succeeds. A compiler failure is
stored with code `compilation_failed`, retaining prior evidence. Do not label
that older snapshot current or healthy.

Completeness is not convergence, and stored convergence does not prove current
network state. Pins identify the observed state. `startedAt`, `completedAt` and
`observedAt` describe local processing time, including cache replay; they do not
prove block freshness. Recompile live-dependent manifests for a fresh attempt.
Execution still needs explicit provider review and deployment verification.

An already-aborted request performs no persistence or RPC. Cancellation after
reservation records a failed attempt and retains prior complete evidence. A
storage error rejects with a fixed code and publishes no candidate. After an
uncertain write, reload the store to inspect what it retained; a read alone
cannot establish the failed write's durability. Use the returned committed
record, including for `outcome: "superseded"`, and ignore older revisions at the
application/UI boundary.

`SqliteFleetObservationStore` uses [Node's SQLite API](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html)
(Node 22.13+), WAL,
FULL synchronization, a 100 ms lock wait, and one row per chain. Transactions
validate records and state transitions before committing. New files use mode
0600; the parent directory must already exist. The database has an explicit
current version and performs no old-schema migration. Observation v1 records
are unsupported and must be recreated. Malformed rows fail
independently; physical database corruption can make the whole database
unavailable. Close stores during host shutdown.

This is a Node-only entry point. Bun 1.3.14 did not successfully import the
SQLite API in the tested environment; the package rejects its `moesi/node`
import before loading SQLite. Bun/browser/database hosts can implement
`FleetObservationStore` using their own atomic storage. `get` returns untrusted
data; `compareAndSwap(next, expectedRevision)` must atomically compare, validate
`assertFleetObservationEvolution`, durably commit and return true, or write
nothing and return false. Never delete and recreate a key while a worker can
still finish against its old revision. `MemoryFleetObservationStore` implements
the contract for tests and ephemeral use. Browser imports of `moesi/fleet` do
not load the Node database code.

The packed consumer typechecks the public API, races two real processes on one
revision, and kills a worker after reservation before reopening and recovering.
[SRA's offline acceptance](dx-review/sra-observation-acceptance.md) exercises the
full saved fleet. Its service and UI adoption remain separate work.

`compile({ chains })` selects source chains while keeping the complete declared
catalog available for `ctx.deployedOn` peer references. Unselected source
configuration callbacks do not run or perform live reads.
