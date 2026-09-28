# @moesi/oaath

## 0.14.0

### Minor Changes

- a22056f: Add the optional public-SDK OAAth execution provider. Explicitly request or reuse
  one all-chain permission, review actual signer/route/enforcement, submit exact
  reviewed actions, and recover finalized SDK calls from durable references.
  The adapter requires `@oaath/sdk@0.2.0`; development uses exact checked-in
  artifacts from its reviewed source commit. Packed CLI recovery survives loss
  of the producing SDK process without another submission.
