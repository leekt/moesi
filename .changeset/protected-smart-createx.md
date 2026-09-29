---
"moesi": minor
"@moesi/oaath": minor
"@moesi/cli": minor
---

Support sender-protected CreateX CREATE2 and CREATE3 from exact smart-account
senders, including offline address prediction through `predictManifestAddresses`.
CREATE3 reproduces the existing SRA Across adapter and resolver addresses.

Breaking: smart-account manifest senders and reviewed-plan sender requirements
now require a concrete `address` alongside `accountId`. Provider review verifies
both, and configuration reads use this exact address. Replace
`deriveCreateXCreate2RawSalt` with `deriveCreateXSenderProtectedRawSalt`.

Manifest, reviewed-plan, and deployment-run versions advance to v5. CLI plan,
execution-review, and run-result wrappers advance to v4. Recreate old persisted
artifacts; no compatibility reader or in-place migration is provided.
