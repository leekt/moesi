---
"moesi": minor
"@moesi/cli": minor
---

Add `parseManifestText` for one bounded JSON or YAML 1.2 document, and allow
`moesi plan --manifest -` to read stdin. Equivalent data produces the same
immutable manifest and plan. Quote YAML addresses, bytes, and decimal values.

Manifest text now rejects duplicate keys, aliases, anchors, explicit tags,
multiple documents, excessive nesting, and input larger than 1 MiB of UTF-8.
Malformed syntax uses `invalid_manifest_document`, replacing the CLI-only
`manifest_json_invalid` code; oversized input uses `manifest_source_too_large`.
Current manifest and plan artifact schemas are unchanged.
