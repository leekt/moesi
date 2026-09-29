# SRA durable observation acceptance

The packed public observation API persisted and reloaded all 22 chains of the
actual SRA migration fleet: 166 resource cells and 2,410 configuration rows.
Every plan remained converged at the original saved pins. All 67 stored decimals
reads retained their exact chain, caller, target, calldata, result and block
hash. A subsequent injected read failure retained the prior complete snapshot
and stored the unreadable current plan separately.

This was an offline replay of [the recorded migration evidence](sra-live-parity.md),
not a fresh network scan. It made zero external RPC requests and had zero cache
misses. The scanner used four concurrent chain workers. Reopening SQLite and
loading all records performed no observer reads.

[The evidence](sra-observation-evidence.json) records the source application
commit, original pin capture time, input/cache hashes, exact local package hash,
implementation/fixture hashes, per-chain plan identities, counts and pins.
The fixture is [sra-observation-consumer.mjs](../../scripts/fixtures/sra-observation-consumer.mjs).
To repeat it, install an exact current `moesi` tarball into a clean Node consumer,
copy the fixture there, and invoke it through `scripts/scrub-live-rpc-env.mjs`
with the saved parity-cache directory and a new output directory. Reads come
exclusively from the saved cache; fetch is disabled and a missing cached read
fails acceptance. It never changes the source cache.

This proves the representation handles the real fleet's size, pinned read
evidence and failure retention. It does not migrate SRA's Bun service, status
projection, refresh queue or UI. The service still needs an atomic Bun store
and the new application-facing status path. Separate packed tests prove process
races and abrupt worker termination using the Node store.
