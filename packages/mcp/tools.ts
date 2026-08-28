import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ADAPTERS, isTargetId } from "../adapters/index.js";
import { runDeploy } from "../core/deploy/engine.js";
import { isDeployEnv, type DeployEnv, type DeployTarget, type TargetId } from "../core/deploy/types.js";
import { assertProFeature, ProFeatureError, type LicenseOptions } from "../core/license.js";
import { scanProject } from "../core/scanner.js";
import {
  assertValidSecretName,
  createVault,
  deriveProjectId,
  SecretNameError,
  type SecretScope,
  type Vault
} from "../core/vault/index.js";
import { deployHumanActionRequired, licenseRequired, saveActionRequired } from "./messages.js";

// Thin wrappers around Phase 1-3 core functions (phase-4-mcp.md section 4).
// No new business logic here: every handler either reports a status derived
// from an existing core return value, or hands off to a human CLI command.
// section 2-15/2-16: no inputSchema below has a value/secret/password
// property, and no response path is built from anything but these core
// return values.

export interface ToolDeps {
  defaultProjectDir: string;
  createVault: () => Vault;
  adapters: ReadonlyMap<TargetId, DeployTarget>;
  pathOverride?: string; // test-only; threaded through to the deploy engine
  licenseOptions?: LicenseOptions; // test-only; threaded through to assertProFeature
}

export function defaultToolDeps(defaultProjectDir: string): ToolDeps {
  return { defaultProjectDir, createVault, adapters: ADAPTERS };
}

type ResolvedDir = { ok: true; dir: string } | { ok: false; message: string };

function resolveDir(defaultDir: string, path: string | undefined): ResolvedDir {
  const dir = path ? resolve(path) : defaultDir;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, message: `NG: path does not exist or is not a directory: ${dir}` };
  }
  return { ok: true, dir };
}

type ValidName = { ok: true } | { ok: false; message: string };

function validateName(name: string): ValidName {
  try {
    assertValidSecretName(name);
    return { ok: true };
  } catch (err) {
    if (err instanceof SecretNameError) {
      return { ok: false, message: `NG: ${err.message}` };
    }
    throw err;
  }
}

async function checkVaultAvailable(vault: Vault): Promise<{ ok: true } | { ok: false; message: string }> {
  if (await vault.isAvailable()) {
    return { ok: true };
  }
  return { ok: false, message: "NG: no OS secret store is available on this system." };
}

function statusResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Converts an unexpected exception into a fixed NG response. Never forwards
// the exception message or stack (CLAUDE.md section 3: no raw text in logs/errors).
function guarded(
  fn: (args: Record<string, unknown>) => Promise<CallToolResult>
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch {
      return errorResult("NG: the operation failed unexpectedly.");
    }
  };
}

export type ToolHandlers = Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>>;

export function buildTools(deps: ToolDeps): ToolHandlers {
  return {
    list_required_secrets: guarded(async (args) => {
      const resolved = resolveDir(deps.defaultProjectDir, args.path as string | undefined);
      if (!resolved.ok) return errorResult(resolved.message);

      const report = scanProject({ targetDir: resolved.dir });
      const names = report.requiredSecrets;
      const text =
        names.length === 0 ? "No required secrets detected." : `Required secrets: ${names.join(", ")}`;
      return statusResult(text, { requiredSecrets: names });
    }),

    check_secret: guarded(async (args) => {
      const name = args.name as string;
      const nameCheck = validateName(name);
      if (!nameCheck.ok) return errorResult(nameCheck.message);

      const scope = ((args.scope as SecretScope | undefined) ?? "project") as SecretScope;
      const resolved = resolveDir(deps.defaultProjectDir, args.path as string | undefined);
      if (!resolved.ok) return errorResult(resolved.message);

      const vault = deps.createVault();
      const availability = await checkVaultAvailable(vault);
      if (!availability.ok) return errorResult(availability.message);

      const projectId = scope === "project" ? deriveProjectId(resolved.dir) : null;
      const registered = await vault.hasSecret({ name, scope, projectId });
      const status = registered ? "registered" : "missing";
      return statusResult(`${registered ? "OK" : "NG"}: ${name} is ${status} (${scope} scope).`, {
        name,
        scope,
        status
      });
    }),

    save_secret: guarded(async (args) => {
      const name = args.name as string;
      const nameCheck = validateName(name);
      if (!nameCheck.ok) return errorResult(nameCheck.message);

      const scope = ((args.scope as SecretScope | undefined) ?? "project") as SecretScope;
      return statusResult(saveActionRequired(name, scope), { action: "action_required", name, scope });
    }),

    deploy_secret: guarded(async (args) => {
      const name = args.name as string;
      const nameCheck = validateName(name);
      if (!nameCheck.ok) return errorResult(nameCheck.message);

      const target = args.target as string;
      if (!isTargetId(target)) {
        return errorResult("NG: target must be one of: cloudflare, vercel, github");
      }

      const env = (args.env as string | undefined) ?? "development";
      if (!isDeployEnv(env)) {
        return errorResult("NG: env must be one of: production, preview, development");
      }

      // section 2-18: production (and github, which is always CI-reachable
      // regardless of --env; see phase-3-deploy.md 6.3) never completes here.
      if (env === "production" || target === "github") {
        return statusResult(deployHumanActionRequired(name, target, env), {
          action: "action_required",
          name,
          target,
          env
        });
      }

      try {
        assertProFeature("deploy", deps.licenseOptions);
      } catch (err) {
        if (err instanceof ProFeatureError) {
          return statusResult(licenseRequired(), { status: "license-required", name, target, env });
        }
        throw err;
      }

      const scope = ((args.scope as SecretScope | undefined) ?? "project") as SecretScope;
      const dryRun = Boolean(args.dryRun);
      const resolved = resolveDir(deps.defaultProjectDir, args.path as string | undefined);
      if (!resolved.ok) return errorResult(resolved.message);

      const adapter = deps.adapters.get(target);
      if (!adapter) return errorResult("NG: target adapter not available.");

      const vault = deps.createVault();
      const availability = await checkVaultAvailable(vault);
      if (!availability.ok) return errorResult(availability.message);

      const projectId = scope === "project" ? deriveProjectId(resolved.dir) : null;
      const printed: string[] = [];

      const result = await runDeploy(
        {
          vault,
          adapter,
          print: (line) => printed.push(line),
          // Fixed false regardless of branching above (section 2-18: multi-layer
          // defense so a logic bug here still cannot complete a production deploy).
          confirmProduction: async () => false,
          pathOverride: deps.pathOverride
        },
        {
          name,
          scope,
          projectId,
          projectDir: resolved.dir,
          env: env as DeployEnv,
          dryRun,
          force: false
        }
      );

      const summary = printed.join("\n");
      switch (result.kind) {
        case "dry-run":
          return statusResult(`OK: dry-run plan for ${name} -> ${target} (${env}).\n${summary}`, {
            status: "dry-run",
            name,
            target,
            env
          });
        case "missing-secret":
          return statusResult(
            `NG: ${name} is not registered (${scope} scope). Ask the human to run: npx api-key-case save ${name}`,
            { status: "missing-secret", name, target, env }
          );
        case "cli-unavailable":
          return statusResult(`NG: ${adapter.cliCommand} is not ready.\n${summary}`, {
            status: "cli-unavailable",
            name,
            target,
            env
          });
        case "declined":
          return statusResult("NG: deploy was not confirmed.", { status: "declined", name, target, env });
        case "executed": {
          const ok = result.handoff.exitCode === 0;
          const detail = result.handoff.stderrRedacted.trim() || result.handoff.stdoutRedacted.trim();
          const text = ok
            ? `OK: ${name} deployed to ${target} (${env}).`
            : `NG: deploy to ${target} failed${result.handoff.timedOut ? " (timed out)" : ""}.${detail ? `\n${detail}` : ""}`;
          return statusResult(text, { status: ok ? "executed" : "failed", name, target, env });
        }
      }
    }),

    generate_env_example: guarded(async (args) => {
      const resolved = resolveDir(deps.defaultProjectDir, args.path as string | undefined);
      if (!resolved.ok) return errorResult(resolved.message);

      const report = scanProject({
        targetDir: resolved.dir,
        writeEnvExample: true,
        force: Boolean(args.force)
      });
      const state = report.envExample;
      const text = state.written ? `OK: wrote ${state.path}.` : `NG: ${state.reason ?? "not written"}`;
      return statusResult(text, {
        path: state.path,
        written: state.written,
        exists: state.exists,
        reason: state.reason ?? null
      });
    }),

    scan_secret_leaks: guarded(async (args) => {
      const resolved = resolveDir(deps.defaultProjectDir, args.path as string | undefined);
      if (!resolved.ok) return errorResult(resolved.message);

      const report = scanProject({ targetDir: resolved.dir });
      const findings = report.secretFindings.map((finding) => ({
        file: finding.file,
        line: finding.line,
        kind: finding.kind,
        preview: finding.preview
      }));
      const text =
        findings.length === 0
          ? "OK: no possible secret leaks detected."
          : `NG: ${findings.length} possible secret value(s) found outside ignored env files.`;
      return statusResult(text, { findingsCount: findings.length, findings, warnings: report.warnings });
    }),

    check_gitignore: guarded(async (args) => {
      const resolved = resolveDir(deps.defaultProjectDir, args.path as string | undefined);
      if (!resolved.ok) return errorResult(resolved.message);

      const report = scanProject({ targetDir: resolved.dir });
      const unignored = report.envFiles.filter((file) => !file.ignored).map((file) => file.file);
      const ok =
        report.gitignore.hasGitignore &&
        report.gitignore.ignoresDotEnv &&
        report.gitignore.ignoresDotEnvVariants &&
        unignored.length === 0;
      const text = ok
        ? "OK: .env and .env.* variants are gitignored."
        : `NG: review .gitignore.${unignored.length > 0 ? ` Not ignored: ${unignored.join(", ")}` : ""}`;
      return statusResult(text, {
        hasGitignore: report.gitignore.hasGitignore,
        ignoresDotEnv: report.gitignore.ignoresDotEnv,
        ignoresDotEnvVariants: report.gitignore.ignoresDotEnvVariants,
        unignoredEnvFiles: unignored
      });
    })
  };
}

const PATH_SCHEMA = { path: z.string().optional() };
const SCOPE_SCHEMA = { scope: z.enum(["user", "project"]).optional() };

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  const tools = buildTools(deps);

  server.registerTool(
    "list_required_secrets",
    {
      description: "List the environment variable names this project needs, from .env.example and source usage. Never returns values.",
      inputSchema: { ...PATH_SCHEMA }
    },
    tools.list_required_secrets
  );

  server.registerTool(
    "check_secret",
    {
      description: "Report whether a named secret is registered in the OS secret store. Returns registered/missing only, never the value.",
      inputSchema: { name: z.string(), ...SCOPE_SCHEMA, ...PATH_SCHEMA }
    },
    tools.check_secret
  );

  server.registerTool(
    "save_secret",
    {
      description:
        "Never accepts or stores a value. Returns an action_required response asking a human to run `api-key-case save` in their own terminal.",
      inputSchema: { name: z.string(), ...SCOPE_SCHEMA }
    },
    tools.save_secret
  );

  server.registerTool(
    "deploy_secret",
    {
      description:
        "Send a registered secret to a deploy target via its official CLI. Production (and github, always CI-reachable) never completes here — returns an action_required response for a human to run in a terminal instead.",
      inputSchema: {
        name: z.string(),
        target: z.enum(["cloudflare", "vercel", "github"]),
        env: z.enum(["production", "preview", "development"]).optional(),
        ...SCOPE_SCHEMA,
        ...PATH_SCHEMA,
        dryRun: z.boolean().optional()
      }
    },
    tools.deploy_secret
  );

  server.registerTool(
    "generate_env_example",
    {
      description: "Write or refresh .env.example with empty-valued keys for every required secret.",
      inputSchema: { ...PATH_SCHEMA, force: z.boolean().optional() }
    },
    tools.generate_env_example
  );

  server.registerTool(
    "scan_secret_leaks",
    {
      description: "Scan the project for possible leaked secret values outside ignored env files. Findings are redacted, never the raw value.",
      inputSchema: { ...PATH_SCHEMA }
    },
    tools.scan_secret_leaks
  );

  server.registerTool(
    "check_gitignore",
    {
      description: "Report whether .env and its variants are covered by .gitignore.",
      inputSchema: { ...PATH_SCHEMA }
    },
    tools.check_gitignore
  );
}
