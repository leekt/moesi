---
"moesi": minor
"@moesi/cli": minor
---

Add `resume({ mode: "observe-only" })` and `moesi resume --observe-only` for automatic
confirmation without starting untouched work. Existing references can finalize;
pending operations retain their durable state and return `pending-execution`.
Default resume still continues untouched work after normal preflight.

Run results now use `moesi.run-result/v7`, and CLI result envelopes use
`moesi.cli-run-result/v9`. Update consumers to these current versions; durable
Run records keep their existing schema.
