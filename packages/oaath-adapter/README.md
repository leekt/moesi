# @moesi/oaath

The optional Moesi execution provider over the public OAAth SDK.

The invariant is one immutable plan and one accepted provider review bound to
the selected owner or session authority. Session authorization is an explicit
action before review. Review and prepare read SDK facts and estimate owner
operations without signing. Prepare binds the exact plan, authority, account,
signer, route and policy; submission refuses a changed binding. Observation
looks up the retained operation and maps its actual finalized calls. Missing or
unreadable evidence never authorizes another submission.

`requestOAAthPlanPermission({ oaath, plan })` compiles all chains' target/selector
and maximum-value requirements into one all-chain request. It reuses the realm's
existing Grant only when every call is covered. It never silently replaces one.
This selector-level permission can cover more calldata than the plan; the
adapter independently submits only the exact reviewed calls.

Packing defaults to `"per-chain"`: all steps on a chain are reviewed together
and sent once through `grant.sendCalls`. The default `perChainOperationLimit`
is the maximum operation count across chains, so an atomic plan needs one
operation per chain regardless of call count. Choose the same
`packing: "per-step"` for both permission compilation/request and execution
review when each action should be a separate operation. Changed packing requires
a new execution review. Every batch retains one reference through recovery.

Existing Kernel v3.3 owner execution uses the public SDK's owner client:

```ts
const provider = createOAAthExecutionProvider({
  oaath, // createOAAth({ mode: "owner", chains, operations })
  account: { kind: "existing", address: fleetAccount },
  owner: walletClient, // connected browser wallet or local viem wallet
  signer: "auto",
  sender: "auto",
});
```

For `signer: "auto"`, a complete chain batch that estimates successfully as one
operation uses the available owner. Plans requiring onchain call, expiry, or
operation-count enforcement retain the session path. Explicit `"owner"` or
`"session"` selection is also supported. Review reports the smart-account
sender, signer reason, actual enforcement, and permitted submission fallback.
An unavailable estimate blocks review without prompting or requesting a grant.

With a wallet and `sender: "auto"`, the SDK may send the same signed operation
through `EntryPoint.handleOps` after a conclusive pre-acceptance bundler
rejection. Ambiguous errors never permit fallback. `sender: "bundler"` disables
that fallback. Finalized evidence retains the actual submission route.

The SDK owner client and issuer-backed session client are currently separate.
Local session orchestration and automatic owner selection after proven session
validation failure remain #62 work; this revision does not claim those paths.

`createOAAthExecutionProvider({ oaath })` implements Moesi's provider contract.
The caller owns the SDK instance and closes it. The route includes the SDK's
actual session signer and submission route plus an authority fingerprint, so a
different Grant or policy invalidates an accepted review. Moesi stores a versioned
opaque session fingerprint or owner account address with the operation ID,
never credentials or SDK lifecycle state. Resume requires the same account and
retained SDK stores. Owner observation needs no connected wallet or permission.

Development currently requires the exact OAAth artifacts in `vendor/oaath`.
Their provenance and SHA-256 sums are checked into that directory. The registry's
older `@oaath/sdk@0.1.0` does not provide the required review/evidence APIs;
the current artifacts and SDK peer requirement are `0.2.0`. They are packed
from the recorded source version; npm publication is a separate action.
The production adapter imports only `@oaath/sdk` types, `moesi`, and `viem`.
Local integration fixtures remain owned by the packed `@oaath/testing/anvil`.
