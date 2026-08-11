import { MoesiPlanError } from "../errors.js";
import { compareAscii } from "../internal.js";
import type {
  DeploymentStep,
  ExecutionRequirements,
  PlanEnforcement,
  PlanSender,
} from "./types.js";

/**
 * Compiles the provider-neutral execution requirement for every chain that owns
 * at least one step. One chain has exactly one sender: every sender-requiring
 * step on the same chain must declare the same sender, because one
 * DeploymentRun binds one provider decision per chain. Enforcement merges to
 * the strongest requirement across the chain's steps.
 */
export function compileExecutionRequirements(
  steps: readonly DeploymentStep[],
): ExecutionRequirements[] {
  const orderedSteps = orderDeploymentSteps(steps);
  const chainIds = [...new Set(steps.map((step) => step.chainId))].sort(
    (left, right) => left - right,
  );
  return chainIds.map((chainId) => {
    const chainSteps = orderedSteps.filter((step) => step.chainId === chainId);
    return {
      chainId,
      calls: chainSteps.map((step) => step.call),
      sender: chainSender(chainId, chainSteps),
      enforcement: chainEnforcement(chainSteps),
      postconditions: chainSteps.flatMap((step) => step.postconditions),
    };
  });
}

/**
 * Canonical executable order: chain, every deployment, then configuration by
 * resource and step id. A configuration action may target code created by the
 * same plan, so no configuration can precede any deployment on that chain.
 */
export function orderDeploymentSteps(steps: readonly DeploymentStep[]): DeploymentStep[] {
  return [...steps].sort((left, right) => {
    const chainOrder = left.chainId - right.chainId;
    if (chainOrder !== 0) return chainOrder;
    if (left.kind !== right.kind) return left.kind === "deploy" ? -1 : 1;
    const resourceOrder = compareAscii(left.resourceId, right.resourceId);
    if (resourceOrder !== 0) return resourceOrder;
    return compareAscii(left.id, right.id);
  });
}

function chainSender(chainId: number, steps: readonly DeploymentStep[]): PlanSender {
  const declared = new Map<string, Exclude<PlanSender, { readonly kind: "sender-independent" }>>();
  for (const step of steps) {
    if (step.sender === null) continue;
    declared.set(senderKey(step.sender), step.sender);
  }
  if (declared.size === 0) return { kind: "sender-independent" };
  if (declared.size > 1) {
    throw new MoesiPlanError(
      "conflicting_senders",
      "plan.steps",
      `chain ${chainId} steps require ${declared.size} different senders`,
    );
  }
  const sender = [...declared.values()][0];
  if (sender === undefined) throw new MoesiPlanError("conflicting_senders", "plan.steps", "sender");
  return sender;
}

function senderKey(sender: Exclude<PlanSender, { readonly kind: "sender-independent" }>): string {
  return sender.kind === "logical-smart-account"
    ? `logical-smart-account:${sender.accountId}`
    : `${sender.kind}:${sender.address}`;
}

function chainEnforcement(steps: readonly DeploymentStep[]): PlanEnforcement {
  return {
    callScope: steps.some((step) => step.enforcement.callScope === "required-onchain")
      ? "required-onchain"
      : "interactive-review-sufficient",
    expiry: steps.some((step) => step.enforcement.expiry === "required") ? "required" : "optional",
    operationLimit: steps.some((step) => step.enforcement.operationLimit === "required")
      ? "required"
      : "optional",
  };
}
