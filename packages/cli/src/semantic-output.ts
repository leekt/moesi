import type { SemanticCheck } from "moesi";

export function formatSemanticCheck(check: SemanticCheck): string {
  const prefix = `kind=${check.kind}`;
  if (check.kind === "ownable-owner") {
    return `${prefix} simulation-caller=${check.caller} expected-owner=${check.expectedOwner}`;
  }
  if (check.kind === "access-control-role") {
    return `${prefix} simulation-caller=${check.caller} role=${check.role} account=${check.account} expected-member=${check.expectedMember} expected-admin-role=${check.expectedAdminRole}`;
  }
  if (check.kind === "erc1967-beacon") {
    return `${prefix} simulation-caller=${check.caller} expected-beacon=${check.expectedBeacon} expected-implementation=${check.expectedImplementation} expected-admin=${check.expectedAdmin}`;
  }
  return `${prefix} expected-implementation=${check.expectedImplementation} expected-admin=${check.expectedAdmin}`;
}
