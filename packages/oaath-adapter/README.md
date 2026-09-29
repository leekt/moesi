# @moesi/oaath

The optional Moesi execution provider over the public OAAth SDK.

The invariant is one immutable plan and one accepted provider review bound to
the selected owner or session authority. Session authorization is an explicit
action before review. Review and prepare read SDK facts and estimate candidate
operations without signing. Prepare binds the exact plan, authority, account,
signer, route and policy; submission refuses a changed binding. Observation
looks up the retained operation and maps its actual finalized calls. Missing or
unreadable evidence never authorizes another submission.

`requestOAAthPlanPermission({ oaath, plans: [plan] })` compiles target/selector
and maximum-value requirements from 1–32 distinct plans into one all-chain
request. This also covers heterogeneous fleet manifests compiled separately for
each source chain. It reuses the realm's existing Grant only when every call is
covered and its operation limit covers the aggregate count on each chain.
It never silently replaces one. Incompatible account requirements are rejected
before consent. Every plan still has its own immutable execution review and Run.
This selector-level permission can cover more calldata than the plan; the
adapter independently submits only the exact reviewed calls.

Packing defaults to `"per-chain"`: all steps on a chain are reviewed together
and sent once through `grant.sendCalls`. The default `perChainOperationLimit`
is the maximum aggregate operation count on any chain across all supplied plans,
so one atomic plan needs one operation per chain regardless of call count.
Two plans on the same chain need two operations. Choose the same
`packing: "per-step"` for both permission compilation/request and execution
review when each action should be a separate operation. Changed packing requires
a new execution review. Every batch retains one reference through recovery.

Owner execution from an existing Kernel account uses the public SDK's owner
client. The SDK detects and proves the account's Kernel version and EntryPoint;
nothing here names them:

```ts
const provider = createOAAthExecutionProvider({
  oaath, // createOAAth({ chains, account: fleetAccount, stores }), no `approvals`
  account: { address: fleetAccount },
  owner: walletClient, // connected wallet, local viem wallet, or any SDK owner key
  signer: "auto",
});
```

Every option except `oaath` is optional, and unknown options are rejected.

For `signer: "auto"`, a complete chain batch that estimates successfully as one
operation uses the available owner. Plans requiring onchain call, expiry, or
operation-count enforcement retain the session path. Explicit `"owner"` or
`"session"` selection is also supported. Review reports the smart-account
sender, signer reason, actual enforcement, and permitted submission fallback.
An unavailable estimate blocks review without prompting or requesting a grant.

When a chain needs multiple operations, `"auto"` estimates the session path if
owner execution is available and the plan permits it. A conclusive account
validation rejection from the SDK selects the owner for that chain with
`signerReason: "session-validation-failed"`. Each owner operation must also
estimate successfully. The accepted review binds that decision to the exact
Grant and plan. A changed validation result, Grant, signer or route requires a
new review. Missing or expired Grants, denied scope, unavailable estimates and
ambiguous submissions do not trigger this fallback. Explicit `"session"` and
required onchain enforcement never switch to owner.

Submission routing is OAAth's. The adapter forwards an optional `payer`, in the
SDK's own `OaathPayer` vocabulary, unchanged to every review and send. With
`payer: { kind: "connected-eoa", wallet }` the SDK may send the same signed
operation through its fallback route after a conclusive pre-acceptance bundler
rejection; `{ kind: "paymaster-service", url, context }` requests sponsorship.
Omit it and the OAAth chain's configured routes decide. Ambiguous errors never
permit fallback. Finalized evidence retains the actual submission route.

Independent runs use caller-reserved session lanes, in the SDK's own
`OaathOperationLane` shape. An unresolved run on one lane does not block the
next run on another:

```ts
const provider = createOAAthExecutionProvider({ oaath, lane: { id: "run_17", nonceKey: 17n } });
```

Lanes are Grant session sequences: a laned provider never selects owner signing,
and `signer: "owner"` with a lane is rejected. The permission must already be
installed on the chain, which the default lane does on its first operation. The
lane is bound into the accepted review and retained in every operation
reference, so `resume` observes the same lane with a provider that has no lane
configured. Moesi core never interprets lanes. OAAth enforces one unresolved
operation per lane.

The adapter reads SDK reviews through the versioned `oaath-calls-review-v1`
contract. Semantic fields (signer, enforcement, validation, fallback condition
and fee payer) are closed and checked. Account implementation and route kind are
opaque identity: bounded and well-formed, bound into the review fingerprint, and
never enumerated. A new Kernel version or submission route therefore needs no
adapter release, while any change to one still invalidates an accepted review.

Wallet-approved sessions combine owner execution and durable sessions for the
same existing account, without an issuer service or phone:

```ts
const account = { address: fleetAccount, accountId: "sra-kernel-v33" } as const;
const oaath = createOAAth({
  account: fleetAccount,
  approvals: { kind: "wallet", owner: walletClient },
  chains,
});
await requestOAAthPlanPermission({ oaath, plans: [plan], account, perChainOperationLimit: 3 });
const provider = createOAAthExecutionProvider({
  oaath, account, owner: walletClient, signer: "session",
  payer: { kind: "connected-eoa", wallet: walletClient },
});
const executionReview = await moesi.reviewExecution({ plan, provider });
await moesi.apply({ plan, provider, executionReview }).wait();
```

Use the same `account` binding for permission requests and the execution provider
when the manifest names a logical smart account. `accountId` maps that Moesi name
to the existing SDK account at `address`; omitted IDs default to the lowercase
address. The SDK's native identity remains part of the authority fingerprint,
so a changed SDK identity invalidates review even when the logical name stays
the same. Without an explicit binding, the manifest's logical ID must match
the SDK's native ID.

Here `chains` is plain SDK chain descriptors or `createViemChainPorts` output. Browser IndexedDB
persists the encrypted session before one wallet EIP-712 approval. A local viem
wallet works too; outside a browser, supply an explicit origin and durable SDK
stores. Session installation, signing, recovery and revocation remain SDK-owned.
Keep its Grant, operation, key and context stores together. Covered later plans
reuse the Grant without another owner approval; every plan still requires its own
Moesi execution review. `oaath.close()` releases resources, while
`oaath.disconnect(grant)` revokes permission before deleting local key custody.

`createOAAthExecutionProvider({ oaath })` implements Moesi's provider contract.
The caller owns the SDK instance and closes it. The route includes the SDK's
actual session signer and submission route plus an authority fingerprint, so a
different Grant or policy invalidates an accepted review. Moesi stores a versioned
opaque session fingerprint or owner account address with the operation ID,
never credentials or SDK lifecycle state. Resume requires the same account and
retained SDK stores. Owner observation needs no connected wallet or permission.

Development currently requires the exact OAAth artifacts in `vendor/oaath`.
Their provenance and SHA-256 sums are checked into that directory. The current
artifacts and SDK peer requirement are `0.3.0`, packed from the published npm
release; `provenance.json` records its source commit. The production adapter
imports only `@oaath/sdk`, `moesi`, and `viem`.
Local integration fixtures remain owned by the packed `@oaath/testing/anvil`.
