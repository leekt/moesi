---
"moesi": patch
"@moesi/oaath": patch
"@moesi/cli": patch
---

Add read-only `uint256-minimum` semantic checks for ABI uint256 return values,
including EntryPoint deposits and native balances read through a pinned balance
reader. Planning and fresh verification accept equality or excess, report values
below the bound as drift, and classify malformed or failed reads as unreadable.
The minimum is immutable reviewed data and never authorizes a funding operation.

Breaking: recreate manifests (v8), reviewed plans (v9), verification results (v6),
Run results (v9), deployment Runs (v11), fleet observations (v4), CLI plan output
(v7), CLI execution reviews (v10), CLI Run results (v11), fleet baselines and parity
reports (v2). Baseline call checks now require their predicate `kind`. Observe
unresolved Runs with the release that created them; do not resend them through new
artifacts.
