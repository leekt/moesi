---
"moesi": minor
"@moesi/cli": minor
---

Add closed manifest `semanticChecks` for Ownable ownership, AccessControl membership/admin roles, and ERC-1967 direct/beacon proxy expectations. Planning compiles exact read-only assertions with explicit semantic kinds and call targets. The plan codec binds those assertions to the manifest; planning and fresh verification reject malformed ABI words as unreadable. These assertions produce no repair calls or authority. CLI review/inspection/verification show their kinds and targets.

Breaking artifact change: manifest, reviewed-plan, and deployment-run versions are v4; CLI plan, execution-review, and run-result versions are v3; core verification-result and run-result versions are v2. Recreate stale artifacts and review again. No compatibility readers or in-place upgrades are provided.
