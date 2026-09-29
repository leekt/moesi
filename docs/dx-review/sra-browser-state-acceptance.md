# SRA browser state checkpoint

This records the earlier `bf97785` checkpoint. The subsequent application
execution evidence is in [the newer checkpoint](sra-browser-execution-acceptance.md).

Moesi commit `12b9651` adds one permission request over up to 32 distinct reviewed
plans and an explicit logical-account binding for existing OAAth accounts. The
CLI forwards that binding from the application-owned SDK module. All Moesi
checks pass: 36 boundary tests, 475 core tests, 49 adapter tests and 149 CLI tests,
plus lint, typecheck and build.

The packed consumer passes against real local chains. One approval covers three
heterogeneous plans; atomic deployment/configuration, covered repair, logical
account names, existing v3.3 local sessions, browser/local owners, conclusive
fallback and recovery across SDK instances and OS processes remain verified.
The SDK's native identity stays in the immutable provider authority fingerprint.

SRA commit `bf97785` on `feat/moesi-014-adoption` consumes that exact adapter
tarball. Shared typed authoring now supports scoped browser plan requests,
including fee-only and single-route reads, without reading unrelated fleet
configuration. Each source retains its own compiler pins and literal plan.

Its native IndexedDB Run store arbitrates revision writes across tabs, retains
submission fences and account/chain scope locks after reopening the browser,
and acknowledges writes only after transaction completion. The installed Chrome
153.0.8010.53 fixture proves one create winner, one fence winner, zero provider
calls for ambiguous recovery, and rollback of a transaction aborted after its
individual write succeeded. It makes zero external requests. SRA retains the
reproducible fixture command and JSON evidence in its browser migration docs.
The focused state/planning and backend suite passes 33 tests; the new modules
and the observation server typecheck.

This is an incomplete application migration. SRA's complete frontend build
still fails because its old deployment, manifest and counter-lab modules use
removed 0.9 APIs. The wallet/UI execution and recovery paths must be replaced
and exercised through the actual app. Orchestra's export, storage, concurrency
and recovery paths also remain required. These storage and adapter checks do
not establish completion of the broader developer/application workflow goal.
