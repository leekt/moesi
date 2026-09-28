# Orchestra compiler artifact storage checkpoint

Orchestra commit `e58ff6b` on `feat/moesi-current-export` retains complete compiler
artifacts in the canonical immutable deployment recipe. The
`orchestra.compiler-artifact/v1` envelope binds the full Foundry, solc or Hardhat
3 JSON to the registered initcode hash and exact encoded constructor suffix.
This checkpoint is a prerequisite for current manifest export, not completion
of the application migration.

The registration browser retains metadata and reference maps, recomputes the
binding after constructor-argument edits, clears it after manual bytecode edits,
and rejects late file reads. The backend independently checks the version,
bounded data-only input and exact initcode binding before the catalog transaction.
Artifact storage belongs only to `deployment_recipe`, not mutable release
metadata. Detail reads validate it against the release initcode; summaries omit
it. Unauthorized detail reads cannot expose it.

The real PostgreSQL proof covers concurrent replacement rejection, full-row
transaction rollback after recipe insertion fails, reopening, and an idempotent
additive migration that preserves all previous recipe fields. Missing historical
compiler inputs remain null. The browser proof runs the actual form and HTTP
client against a controlled API boundary; the PostgreSQL proof independently
uses the real application and route handlers. A combined browser-to-database
export/deployment proof remains required.

Validation passed with Bun 1.3.14: nine focused backend artifact tests, eight
Chromium artifact tests, and the full `bun run verify` gate. The full gate ran
382 backend tests with real PostgreSQL required, 937 frontend tests, 13 design
checks, lint, typechecks, builds and audit. Eight opt-in frontend Anvil tests were
skipped and are not evidence for this checkpoint. The production bundle retains
its existing large-chunk warning.

Orchestra still uses Moesi 0.12 for export and settlement. The current literal
manifest compiler, constructor-dependent runtime evidence, public Moesi/OAAth
execution and application recovery must replace those paths. No compatibility
adapter or parallel runtime dependency was introduced by this storage change.
