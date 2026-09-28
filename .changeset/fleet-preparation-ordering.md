---
"moesi": minor
---

Reserve observation revisions before compiling live-dependent manifests.
`observeFleetChain` now takes a `definitionHash` and asynchronous `prepare`
callback instead of a previously compiled manifest. This prevents an older,
slower compilation from overwriting a newer scan and persists compiler failures
and cancellation while retaining prior complete observations. Observation
records are now `moesi.fleet-observation/v2`; v1 records must be recreated.
