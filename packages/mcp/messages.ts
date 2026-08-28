import type { DeployEnv, TargetId } from "../core/deploy/types.js";
import { PURCHASE_URL } from "../core/license.js";
import type { SecretScope } from "../core/vault/types.js";

// Fixed, human-facing instruction text (phase-4-mcp.md section 4 / section 2-17).
// An agent must never be given a way to supply a secret value or a
// production "yes" itself; every path that would require one instead hands
// off to a literal CLI command for a human to run in their own terminal.

export function saveActionRequired(name: string, scope: SecretScope): string {
  const scopeFlag = scope === "user" ? " --scope user" : "";
  return (
    "action_required: api-key-case never accepts a secret value from an agent. " +
    `Ask the human to run: npx api-key-case save ${name}${scopeFlag}`
  );
}

export function deployHumanActionRequired(name: string, target: TargetId, env: DeployEnv): string {
  return (
    "action_required: production deploys require human confirmation in a terminal. " +
    `Ask the human to run: npx api-key-case deploy ${name} --target ${target} --env ${env}`
  );
}

// A normal NG status, not isError (phase-5-license.md §4.3): the agent can
// relay the purchase link to the human as part of ordinary conversation.
export function licenseRequired(): string {
  return (
    "NG: deploy is a Pro feature (one-time purchase). " +
    "The current scan/save/check/list/remove/targets feature set and every MCP tool but deploy_secret are free. " +
    `Ask the human to buy a license: ${PURCHASE_URL} Then run: npx api-key-case license activate`
  );
}
