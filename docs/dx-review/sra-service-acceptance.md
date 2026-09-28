# SRA service acceptance

The isolated SRA adoption branch at
`68c490362e48cb21d2573cdd44ea86c4aa09c31c` replaces its observation backend with
current public Moesi APIs. It consumes the exact packed `moesi@0.14.0` artifact
from `58521cd` (SHA-256
`713aceb09e412064e86556be44ba4e152203f44a0f325021af7be40d69976d2f`). The service's
native `bun:sqlite` adapter implements the public atomic observation store
contract; it does not import `moesi/node` or another repository's source.

The checked-in [evidence](sra-service-evidence.json) comes from SRA's
`server/scripts/accept-observations.ts`. It runs the actual typed authoring,
scanner, native SQLite store, offline load validation and Hono HTTP handlers.
The fixture contains the original public observations captured on 2026-09-28
for SRA `0726cbf6654ee5d26aea7a8dcf734ce8bf68e3ff`. It contains no credentials or
endpoint URLs. This replay does not claim current live state.

The new application manifest adds explicit Across spoke-pool checks. The old
cache lacked those 21 reads, so SRA's capture script evaluates the immutable
getter in local Anvil using each chain's exact saved runtime. The compressed
fixture records these supplemental results and runtime hashes separately.
They are local EVM evaluations, not additional historical RPC responses.

Results:

- All 22 source chains compile independently with the full peer catalog.
- The 166 cells and 2,410 configuration rows converge at the saved pins.
- There are zero missing fixture reads and zero external RPC requests.
- Reopening SQLite and requesting status twice produces the identical product
  projection and manifest hashes, without observer reads.
- A subsequent compilation failure retains the last complete snapshot.
- The measured fixture observation takes 6,493 ms; offline reopen plus two
  handler requests takes 2,550 ms. These do not estimate live RPC latency.

SRA's full suite passes 48 tests, including separate-process revision races,
SIGKILL after reservation/recovery, corrupt row isolation, definition/read
validation, exact decimal and runtime evidence, cancellation, stale callback
rejection, refresh coalescing, and bounded authenticated HTTP requests.
Frontend/server typechecks, focused lint and the production build pass.

The deployment material is also reproducible from the original literal groups
and the independent compiler-artifact evaluation. Import validates initcode,
runtime hashes, constructor context, sender identity and predicted addresses.
Changed artifact/context inputs fail compilation until that evidence is
regenerated; observed bytecode is never adopted as the desired runtime.

Browser execution remains on 0.9. SRA's full OAAth/browser migration and the
Orchestra export/database/browser paths remain required. The backend proof
must not be used as evidence that those application paths are complete.
