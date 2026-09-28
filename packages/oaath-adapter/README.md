# @moesi/oaath

The optional Moesi execution provider over the public OAAth SDK.

The invariant is one immutable plan, one explicit Grant, and one accepted
provider review. Authorization is an explicit action before review. Review and
prepare only read SDK facts. Prepare binds the exact plan, Grant, account,
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

The current SDK-backed grant path reports `signer: "session"` and
`signerReason: "session-authorized"`. Owner selection and existing Kernel v3.3
support are still under implementation for issues #61/#62; this batch change
does not claim those behaviors.

`createOAAthExecutionProvider({ oaath })` implements Moesi's provider contract.
The caller owns the SDK instance and closes it. The route includes the SDK's
actual session signer and submission route plus an authority fingerprint, so a
different Grant or policy invalidates an accepted review. Moesi stores a versioned
opaque Grant fingerprint and operation ID, never credentials or SDK lifecycle
state. Resume requires the same OAAth realm and its retained public SDK stores.

Development currently requires the exact OAAth artifacts in `vendor/oaath`.
Their provenance and SHA-256 sums are checked into that directory. The registry's
older `@oaath/sdk@0.1.0` does not provide the required review/evidence APIs;
the current artifacts and SDK peer requirement are `0.2.0`. They are packed
from the reviewed source version; npm publication is a separate action.
The production adapter imports only `@oaath/sdk` types, `moesi`, and `viem`.
Local integration fixtures remain owned by the packed `@oaath/testing/anvil`.
