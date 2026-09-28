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
adapter independently submits only the exact reviewed action.

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
