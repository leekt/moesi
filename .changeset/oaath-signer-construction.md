---
"@moesi/oaath": patch
---

`createOAAthExecutionProvider` now rejects an explicit `signer` the supplied
client cannot provide with `oaath_input_invalid` at construction, instead of
blocking later at review. `signer: "session"` needs a connectable client;
`signer: "owner"` needs an owner client and `account`. A wallet-less owner
configuration stays valid for recovery-only observation. Unknown `account`
binding fields are now reported as `oaath_input_invalid` rather than
`oaath_sdk_invalid`.
