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
  }
}

const RUN_RECOVERY: Record<RunExecutionFailure, string> = {
  "execution-failed":
    "A transaction failed. Inspect the retained transaction and current chain state, then create and review a fresh plan for remaining work.",
  "invalid-evidence":
    "Execution evidence could not be trusted. Investigate the retained transaction before creating or submitting any replacement work.",
  "call-mismatch":
    "The observed transaction does not match the reviewed call. Investigate its retained reference before submitting any replacement work.",
  "execution-unresolved":
    "A submitted transaction is still pending or could not be observed. Use resume with the same store and confirmation count to observe it without resending.",
  "submission-ambiguous":
    "A transaction may have been submitted, but no reference was retained. Preserve the run store and reconcile the sender's transaction history. Resume cannot safely resend this step.",
  "stop-requested":
    "Work stopped at a safe boundary. Use status to inspect saved progress, then resume with the original settings when ready.",
  "deployment-capability-mismatch":
    "The deployment factory no longer matches the reviewed runtime. No transaction for this step was submitted. Investigate the factory before resuming.",
  "deployment-capability-unverified":
    "The deployment factory could not be verified. No transaction for this step was submitted. Check the RPC and chain evidence, then resume.",
  "deployment-prerequisite-mismatch":
    "A required resource no longer matches the reviewed runtime. No transaction for this step was submitted. Resolve the prerequisite before resuming.",
  "deployment-prerequisite-unverified":
    "A runtime prerequisite could not be verified. No transaction for this step was submitted. Check the RPC and chain evidence, then resume.",
  "configuration-runtime-mismatch":
    "The configuration target or an earlier deployment has unexpected runtime code. No transaction for this step was submitted. Investigate before resuming.",
  "configuration-runtime-unverified":
    "Runtime code needed for configuration could not be verified. No transaction for this step was submitted. Check the RPC and chain evidence, then resume.",
};

export function runRecovery(reason: RunExecutionFailure): string {
  return RUN_RECOVERY[reason];
}

export function statusGuidance(record: DeploymentRunRecord): readonly string[] {
  const lines: string[] = [];
  if (record.steps.some(({ phase }) => phase === "submission-requested")) {
    lines.push(runRecovery("submission-ambiguous"));
  }
  if (record.steps.some(({ phase }) => phase === "submitted")) {
    lines.push(runRecovery("execution-unresolved"));
  }
  if (record.steps.some(({ phase }) => phase === "failed")) {
    lines.push(
      "Some execution steps failed. Inspect their reasons and retained references before creating a fresh plan.",
    );
  }
  if (record.steps.some(({ phase }) => phase === "pending")) {
    lines.push(
      "Pending steps have not been submitted. Resume may execute reachable pending work and requires the original reviewed signers.",
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
  "unsupported-account": "Direct viem execution requires an ordinary EOA wallet.",
  "submission-unavailable":
    "The wallet cannot submit transactions. Check the wallet configuration.",
  "smart-account-sender-required":
    "This plan requires a smart account. The CLI's viem provider cannot satisfy it; use a provider that supports this requirement through the library.",
  "sender-mismatch":
    "The signer differs from the plan's required sender. Supply the required signer and review again.",
  "observer-unavailable":
    "The RPC reader is unavailable. Check its connectivity and configuration.",
  "observer-chain-mismatch":
    "The RPC is on a different chain. Correct the binding and review again.",
  "onchain-call-scope-required":
    "The plan requires onchain call restrictions, which direct viem does not enforce. Use a provider that satisfies the requirement.",
  "onchain-expiry-required":
    "The plan requires onchain expiry, which direct viem does not enforce. Use a provider that satisfies the requirement.",
  "onchain-operation-limit-required":
    "The plan requires an onchain operation limit, which direct viem does not enforce. Use a provider that satisfies the requirement.",
};

export function providerGuidance(code: string): string {
  return Object.hasOwn(PROVIDER_HELP, code)
    ? PROVIDER_HELP[code]!
    : "Resolve this provider requirement before reviewing again.";
}
