import type { DeploymentRunRecord, ReviewedPlan, RunExecutionFailure } from "moesi";

export function planGuidance(disposition: ReviewedPlan["disposition"]): string {
  switch (disposition) {
    case "converged":
      return "All observed resources match the manifest. No transactions are planned.";
    case "changes":
      return "Changes are planned. Inspect the saved plan, then run apply to review its provider. Nothing has been submitted.";
    case "partial":
      return "Only some changes can be planned. Applying the scheduled calls will leave unresolved blockers; inspect them before proceeding.";
    case "blocked":
      return "No executable changes are planned. Resolve the missing prerequisites, unreadable evidence, or verify-only drift, then plan again.";
    case "pending":
      return "Required peer resources are not ready. Resolve the peer dependencies, then create a fresh plan.";
  }
}

const RUN_RECOVERY: Record<RunExecutionFailure, string> = {
  "pending-execution":
    "Some reviewed operations have not started. Observe-only mode left them pending. Resume without --observe-only and with the reviewed authority when ready to execute them.",
  "configuration-peer-unverified":
    "A required peer could not be verified. The current operation was not submitted. Check the peer's pinned evidence and RPC binding before resuming.",
  "execution-failed":
    "An operation failed. Inspect the retained reference and current chain state, then create and review a fresh plan for remaining work.",
  "invalid-evidence":
    "Execution evidence could not be trusted. Investigate the retained transaction before creating or submitting any replacement work.",
  "call-mismatch":
    "The observed operation does not match the reviewed calls. Investigate its retained reference before submitting any replacement work.",
  "execution-unresolved":
    "A submitted operation is still pending or could not be observed. Use resume with the original store and provider settings to observe it without resending.",
  "submission-ambiguous":
    "An operation may have been submitted, but no reference was retained. Preserve the run store and reconcile the sender's transaction history. Resume cannot safely resend this operation.",
  "stop-requested":
    "Work stopped at a safe boundary. Use status to inspect saved progress, then resume with the original settings when ready.",
  "deployment-capability-mismatch":
    "The deployment factory no longer matches the reviewed runtime. The current operation was not submitted. Investigate the factory before resuming.",
  "deployment-capability-unverified":
    "The deployment factory could not be verified. The current operation was not submitted. Check the RPC and chain evidence, then resume.",
  "deployment-prerequisite-mismatch":
    "A required resource no longer matches the reviewed runtime. The current operation was not submitted. Resolve the prerequisite before resuming.",
  "deployment-prerequisite-unverified":
    "A runtime prerequisite could not be verified. The current operation was not submitted. Check the RPC and chain evidence, then resume.",
  "configuration-runtime-mismatch":
    "The configuration target or an earlier deployment has unexpected runtime code. The current operation was not submitted. Investigate before resuming.",
  "configuration-runtime-unverified":
    "Runtime code needed for configuration could not be verified. The current operation was not submitted. Check the RPC and chain evidence, then resume.",
};

export function runRecovery(reason: RunExecutionFailure): string {
  return RUN_RECOVERY[reason];
}

export function statusGuidance(record: DeploymentRunRecord): readonly string[] {
  const lines: string[] = [];
  if (record.operations.some(({ phase }) => phase === "submission-requested")) {
    lines.push(runRecovery("submission-ambiguous"));
  }
  if (record.operations.some(({ phase }) => phase === "submitted")) {
    lines.push(runRecovery("execution-unresolved"));
  }
  if (record.operations.some(({ phase }) => phase === "failed")) {
    lines.push(
      "Some operations failed. Inspect their reasons and retained references before creating a fresh plan.",
    );
  }
  if (record.operations.some(({ phase }) => phase === "pending")) {
    lines.push(
      "Pending operations have not been submitted. Resume may execute reachable pending work and requires the original reviewed signers.",
    );
  }
  lines.push(
    "This is saved execution state. Use moesi verify --plan <path> with the plan's chain bindings to check fresh convergence.",
  );
  return lines;
}

const PROVIDER_HELP: Readonly<Record<string, string>> = {
  "wallet-unavailable": "Supply a signer for this chain.",
  "sender-unavailable": "Check the signer account for this chain.",
  "chain-mismatch": "The wallet is connected to a different chain. Check the chain binding.",
  "unsupported-account": "Direct cetane execution requires an ordinary EOA wallet.",
  "submission-unavailable":
    "The wallet cannot submit transactions. Check the wallet configuration.",
  "smart-account-sender-required":
    "This plan requires a smart account. Configure the matching account through --provider oaath and --oaath-client, then review again.",
  oaath_grant_required:
    "The session client has no retained permission. Run authorize with this plan and packing, then review again.",
  oaath_owner_required:
    "Configure the existing account and its owner wallet in the OAAth client module, then review again.",
  oaath_sender_incompatible:
    "The configured OAAth account does not match the required sender. Check the account address and logical account ID.",
  oaath_review_unavailable:
    "OAAth could not verify authority or estimate the complete operation. Check its chain and bundler settings, then review again.",
  oaath_review_changed:
    "The OAAth authority or submission policy changed. Obtain a fresh review before accepting execution.",
  "sender-mismatch":
    "The signer differs from the plan's required sender. Supply the required signer and review again.",
  "observer-unavailable":
    "The RPC reader is unavailable. Check its connectivity and configuration.",
  "observer-chain-mismatch":
    "The RPC is on a different chain. Correct the binding and review again.",
  "onchain-call-scope-required":
    "The plan requires onchain call restrictions, which direct cetane does not enforce. Use a provider that satisfies the requirement.",
  "onchain-expiry-required":
    "The plan requires onchain expiry, which direct cetane does not enforce. Use a provider that satisfies the requirement.",
  "onchain-operation-limit-required":
    "The plan requires an onchain operation limit, which direct cetane does not enforce. Use a provider that satisfies the requirement.",
};

export function providerGuidance(code: string): string {
  return Object.hasOwn(PROVIDER_HELP, code)
    ? PROVIDER_HELP[code]!
    : "Resolve this provider requirement before reviewing again.";
}
