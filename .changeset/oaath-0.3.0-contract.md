---
"@moesi/oaath": minor
"@moesi/cli": patch
---

Require `@oaath/sdk@0.3.0` and read SDK reviews through its versioned
`oaath-calls-review-v1` contract. Semantic fields (signer, enforcement,
validation, fallback condition and fee payer) stay closed and checked; account
implementation and submission route are opaque identity bound into the review
fingerprint. A new Kernel version or submission route needs no adapter release,
and any change to one still invalidates an accepted review.

Breaking: the `sender` option is removed. Submission routing belongs to OAAth.
Pass an optional `payer` in the SDK's own `OaathPayer` shape instead; it is
forwarded unchanged to every review and send. Handle-ops fallback now requires
`payer: { kind: "connected-eoa", wallet }` and is no longer enabled implicitly
by supplying `owner`. `{ kind: "paymaster-service", ... }` requests sponsorship.
`owner` accepts any SDK owner key. Unknown provider options fail with
`oaath_input_invalid`. Windowed SDK operation limits count their per-window
`count`. Provider review routes and reason codes now carry the SDK's route kinds
(for example `oaath-session-erc4337-bundler:…`, `oaath_route_available:erc4337-bundler`),
so reviews accepted under 0.2.0 must be recreated.
