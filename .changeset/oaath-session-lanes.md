---
"@moesi/oaath": minor
---

Add an optional `lane` to `createOAAthExecutionProvider`, in the SDK's own
`OaathOperationLane` shape, so a receipt-unknown run on one caller-reserved
session lane no longer blocks the next run on another. Lanes are session-only:
a laned provider never selects owner signing, and `signer: "owner"` with a lane
fails with `oaath_input_invalid`. The lane is bound into the accepted review and
retained in each operation reference, so `resume` needs no lane configuration.
Moesi core is unchanged.

Operation references move to `oaath-op-v3`, which names the lane (`default` or
`lane.<nonceKey>.<id>`). References retained as `oaath-op-v2` are unsupported and
observe as `invalid-evidence`.
