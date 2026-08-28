import { assertValidSecretName, type SecretRef, type SecretScope, type Vault } from "../vault/types.js";
import { runWithSecret, type HandoffResult } from "./handoff.js";
import type { DeployEnv, DeployTarget, TargetId } from "./types.js";

// The common deploy flow (phase-3-deploy.md §3.2). Has no direct terminal
// I/O of its own: `print` and `confirmProduction` are injected so the CLI
// (or, later, an MCP wrapper — see §12) owns the TTY.
export interface EngineDeps {
  vault: Vault;
  adapter: DeployTarget;
  print: (line: string) => void;
  confirmProduction: (summary: string) => Promise<boolean>;
  pathOverride?: string; // test-only; threaded through to which.ts
}

export interface DeployRequest {
  name: string;
  scope: SecretScope;
  projectId: string | null;
  projectDir: string;
  env: DeployEnv;
  dryRun: boolean;
  force: boolean;
}

export type DeployResult =
  | { kind: "cli-unavailable" }
  | { kind: "missing-secret" }
  | { kind: "dry-run" }
  | { kind: "declined" }
  | { kind: "executed"; handoff: HandoffResult };

export async function runDeploy(deps: EngineDeps, request: DeployRequest): Promise<DeployResult> {
  assertValidSecretName(request.name);

  const ref: SecretRef = { name: request.name, scope: request.scope, projectId: request.projectId };

  const detect = await deps.adapter.detect(request.projectDir);
  if (!detect.detected) {
    deps.print(
      `Warning: ${deps.adapter.id} was not detected in this project (${detect.reason}). Continuing anyway.`
    );
  }

  const cli = await deps.adapter.checkCli();
  if (!cli.installed || !cli.loggedIn) {
    const reason = !cli.installed ? "is not installed" : "is not logged in";
    deps.print(`NG: ${deps.adapter.cliCommand} ${reason}. Do these steps manually:`);
    for (const [index, step] of deps.adapter.manualSteps(request.name, request.env).entries()) {
      deps.print(`  ${index + 1}. ${step}`);
    }
    deps.print("Note: api-key-case never prints the value. Copy it from where you originally saved it.");
    return { kind: "cli-unavailable" };
  }

  const hasSecret = await deps.vault.hasSecret(ref);
  if (!hasSecret) {
    const fallback =
      request.scope === "project" ? " Try --scope user or" : "";
    deps.print(
      `NG: ${request.name} is not registered in ${request.scope} scope.${fallback} Run: api-key-case save ${request.name}`
    );
    return { kind: "missing-secret" };
  }

  const plan = deps.adapter.planDeploy(request.name, request.env, { force: request.force });

  deps.print("Deploy plan:");
  deps.print(`  secret : ${request.name} (${request.scope} scope)`);
  deps.print(`  target : ${deps.adapter.id} (${deps.adapter.cliCommand})`);
  deps.print(`  env    : ${request.env}`);
  deps.print(`  command: ${plan.displayCommand}`);
  if (plan.overwriteWarning) {
    deps.print("  note   : this may overwrite an existing value on the platform.");
  }

  if (request.dryRun) {
    return { kind: "dry-run" };
  }

  // A GitHub secret of either kind (repository or environment) is placed for
  // CI to consume, and we cannot see which workflows will read it, so treat
  // every env as production-sensitive regardless of --env (phase-3-deploy.md §6.3).
  const requiresConfirmation = request.env === "production" || deps.adapter.id === "github";
  if (requiresConfirmation) {
    const confirmed = await deps.confirmProduction("Type 'yes' to deploy to production:");
    if (!confirmed) {
      deps.print("Aborted: production confirmation was not given.");
      return { kind: "declined" };
    }
  }

  const handoff = await runWithSecret(deps.vault, ref, plan, { pathOverride: deps.pathOverride });
  return { kind: "executed", handoff };
}

export interface TargetStatus {
  id: TargetId;
  detected: boolean;
  detectReason: string;
  cliInstalled: boolean;
  cliVersion?: string;
  loggedIn: boolean;
  hint?: string;
}

export async function inspectTargets(
  projectDir: string,
  adapters: Iterable<DeployTarget>
): Promise<TargetStatus[]> {
  const results: TargetStatus[] = [];
  for (const adapter of adapters) {
    const detect = await adapter.detect(projectDir);
    const cli = await adapter.checkCli();
    results.push({
      id: adapter.id,
      detected: detect.detected,
      detectReason: detect.reason,
      cliInstalled: cli.installed,
      cliVersion: cli.version,
      loggedIn: cli.loggedIn,
      hint: cli.hint
    });
  }
  return results;
}
