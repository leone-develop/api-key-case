#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ADAPTERS, isTargetId } from "../adapters/index.js";
import { inspectTargets, runDeploy } from "../core/deploy/engine.js";
import { isDeployEnv, type DeployEnv, type TargetId } from "../core/deploy/types.js";
import {
  assertProFeature,
  deactivateLicense,
  ProFeatureError,
  PURCHASE_URL,
  readLicenseStatus
} from "../core/license.js";
import { activatePurchaseLicense } from "../core/license-exchange.js";
import { createMcpServer } from "../mcp/server.js";
import { renderTextReport } from "../core/report.js";
import { scanProject } from "../core/scanner.js";
import {
  assertValidSecretName,
  createVault,
  deriveProjectId,
  listSecrets,
  removeSecret,
  saveSecret,
  SecretNameError,
  type SecretRef,
  type SecretScope
} from "../core/vault/index.js";
import { confirm, confirmExact, promptPurchaseLicenseKey, promptSecretValue } from "./prompt.js";

type ScanArgs = {
  targetDir: string;
  json: boolean;
  strict: boolean;
  writeEnvExample: boolean;
  agentReport: boolean;
  force: boolean;
};

type SaveArgs = { name: string; scope: SecretScope; force: boolean };
type CheckArgs = { name: string | null; scope: SecretScope; json: boolean; strict: boolean; targetDir: string };
type ListArgs = { scope: SecretScope; json: boolean; targetDir: string };
type RemoveArgs = { name: string; scope: SecretScope; yes: boolean };
type DeployArgs = {
  name: string;
  target: TargetId;
  env: DeployEnv;
  scope: SecretScope;
  dryRun: boolean;
  force: boolean;
  targetDir: string;
};
type TargetsArgs = { targetDir: string; json: boolean };

main(process.argv.slice(2)).catch(() => {
  console.error("Unexpected error.");
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const [command = "help", ...rest] = argv;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    printVersion();
    return;
  }

  if (command === "scan") {
    runScan(rest);
    return;
  }

  if (command === "save") {
    await runSave(rest);
    return;
  }

  if (command === "check") {
    await runCheck(rest);
    return;
  }

  if (command === "list") {
    await runList(rest);
    return;
  }

  if (command === "remove") {
    await runRemove(rest);
    return;
  }

  if (command === "deploy") {
    await runDeployCommand(rest);
    return;
  }

  if (command === "targets") {
    await runTargetsCommand(rest);
    return;
  }

  if (command === "mcp") {
    await runMcpCommand(rest);
    return;
  }

  if (command === "license") {
    await runLicenseCommand(rest);
    return;
  }

  console.error("Unknown command.");
  printHelp();
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// scan (unchanged behavior)
// ---------------------------------------------------------------------------

function runScan(rest: string[]): void {
  const parsed = parseScanArgs(rest);

  try {
    const report = scanProject({
      targetDir: parsed.targetDir,
      writeEnvExample: parsed.writeEnvExample,
      agentReport: parsed.agentReport,
      force: parsed.force
    });

    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(renderTextReport(report));
    }

    if (parsed.strict && report.warnings.length > 0) {
      process.exitCode = 2;
    }
  } catch {
    console.error("Scan failed. Check the target path and file permissions, then try again.");
    process.exitCode = 1;
  }
}

function parseScanArgs(rest: string[]): ScanArgs {
  let targetDir = process.cwd();
  let json = false;
  let strict = false;
  let writeEnvExample = false;
  let agentReport = false;
  let force = false;

  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--write-env-example") {
      writeEnvExample = true;
    } else if (arg === "--agent-report") {
      agentReport = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      process.exit(1);
    } else {
      targetDir = resolve(arg);
    }
  }

  return { targetDir, json, strict, writeEnvExample, agentReport, force };
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

async function runSave(rest: string[]): Promise<void> {
  const positionals: string[] = [];
  let scope: SecretScope = "project";
  let force = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      process.exit(1);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    console.error("Usage: api-key-case save <NAME> [--scope user|project] [--force]");
    process.exit(1);
  }

  if (positionals.length > 1) {
    console.error(
      "NG: refusing to accept a secret value as a command-line argument. " +
        "It may already be in your shell history; rotate this key."
    );
    process.exit(1);
  }

  const name = positionals[0];
  validateNameOrExit(name);

  if (!process.stdin.isTTY) {
    console.error("NG: secret input requires an interactive terminal.");
    process.exit(1);
  }

  const vault = createVault();
  await requireVaultAvailable(vault);

  const targetDir = process.cwd();
  const ref: SecretRef = {
    name,
    scope,
    projectId: scope === "project" ? deriveProjectId(targetDir) : null
  };

  if (!force && (await vault.hasSecret(ref))) {
    console.error(`NG: ${name} already exists (use --force to overwrite)`);
    process.exit(1);
  }

  const value = await promptSecretValue(name);
  const projectPath = scope === "project" ? normalizePath(targetDir) : null;
  await saveSecret(vault, ref, value, projectPath);

  console.log(`OK: ${name} saved to ${scope} scope.`);
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function runCheck(rest: string[]): Promise<void> {
  const args = parseCheckArgs(rest);
  if (args.name) {
    validateNameOrExit(args.name);
  }

  const vault = createVault();
  await requireVaultAvailable(vault);

  if (args.name) {
    const ref: SecretRef = {
      name: args.name,
      scope: args.scope,
      projectId: args.scope === "project" ? deriveProjectId(args.targetDir) : null
    };
    const registered = await vault.hasSecret(ref);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            scope: args.scope,
            projectId: ref.projectId,
            name: args.name,
            status: registered ? "registered" : "missing",
            backend: vault.backendName
          },
          null,
          2
        )
      );
    } else if (registered) {
      console.log(`OK: ${args.name} is registered (${args.scope} scope).`);
    } else {
      console.log(`NG: ${args.name} is not registered.`);
    }

    if (args.strict && !registered) {
      process.exitCode = 2;
    }
    return;
  }

  let report;
  try {
    report = scanProject({ targetDir: args.targetDir });
  } catch {
    console.error("Scan failed. Check the target path and file permissions, then try again.");
    process.exitCode = 1;
    return;
  }
  const projectId = args.scope === "project" ? deriveProjectId(args.targetDir) : null;

  const secrets: { name: string; status: "registered" | "missing" }[] = [];
  for (const name of report.requiredSecrets) {
    const registered = await vault.hasSecret({ name, scope: args.scope, projectId });
    secrets.push({ name, status: registered ? "registered" : "missing" });
  }
  const missingCount = secrets.filter((entry) => entry.status === "missing").length;

  if (args.json) {
    console.log(
      JSON.stringify(
        { scope: args.scope, projectId, secrets, missingCount, backend: vault.backendName },
        null,
        2
      )
    );
  } else if (secrets.length === 0) {
    console.log("No required secrets detected.");
  } else {
    console.log("Required secrets (from scan):");
    for (const entry of secrets) {
      const label = entry.status === "registered" ? "OK " : "NG ";
      const detail = entry.status === "registered" ? `registered (${args.scope})` : "missing";
      console.log(`  ${label} ${entry.name}   ${detail}`);
    }
    console.log("");
    if (missingCount > 0) {
      console.log(`${missingCount} missing. Run: api-key-case save <NAME>`);
    } else {
      console.log("All required secrets are registered.");
    }
  }

  if (args.strict && missingCount > 0) {
    process.exitCode = 2;
  }
}

function parseCheckArgs(rest: string[]): CheckArgs {
  let scope: SecretScope = "project";
  let json = false;
  let strict = false;
  let targetDir = process.cwd();
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      process.exit(1);
    } else {
      positionals.push(arg);
    }
  }

  // First positional is the secret NAME (optional); a second positional is
  // the project path. Validation of NAME happens after parsing.
  const name = positionals.length > 0 ? positionals[0] : null;
  if (positionals.length > 1) {
    targetDir = resolve(positionals[1]);
  }

  return { name, scope, json, strict, targetDir };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(rest: string[]): Promise<void> {
  const args = parseListArgs(rest);

  const vault = createVault();
  await requireVaultAvailable(vault);

  const projectId = args.scope === "project" ? deriveProjectId(args.targetDir) : null;
  const entries = await listSecrets(vault, args.scope, projectId);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          scope: args.scope,
          entries: entries.map((entry) => ({
            name: entry.name,
            scope: entry.scope,
            updatedAt: entry.updatedAt,
            storeStatus: entry.storeStatus
          }))
        },
        null,
        2
      )
    );
    return;
  }

  if (entries.length === 0) {
    console.log(`No secrets registered (${args.scope} scope).`);
    return;
  }

  console.log(`Registered secrets (${args.scope} scope):`);
  for (const entry of entries) {
    console.log(`  ${entry.name}   updated=${entry.updatedAt}   status=${entry.storeStatus}`);
  }
}

function parseListArgs(rest: string[]): ListArgs {
  let scope: SecretScope = "project";
  let json = false;
  let targetDir = process.cwd();

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      process.exit(1);
    } else {
      targetDir = resolve(arg);
    }
  }

  return { scope, json, targetDir };
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

async function runRemove(rest: string[]): Promise<void> {
  const positionals: string[] = [];
  let scope: SecretScope = "project";
  let yes = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      process.exit(1);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 1) {
    console.error("Usage: api-key-case remove <NAME> [--scope user|project] [--yes]");
    process.exit(1);
  }

  const name = positionals[0];
  validateNameOrExit(name);

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("NG: confirmation requires --yes in a non-interactive terminal.");
      process.exit(1);
    }
    const confirmed = await confirm(`Remove ${name} (${scope} scope)? [y/N]`);
    if (!confirmed) {
      console.error("Aborted.");
      process.exit(1);
    }
  }

  const vault = createVault();
  await requireVaultAvailable(vault);

  const targetDir = process.cwd();
  const ref: SecretRef = {
    name,
    scope,
    projectId: scope === "project" ? deriveProjectId(targetDir) : null
  };

  const existed = await removeSecret(vault, ref);
  if (existed) {
    console.log(`OK: ${name} removed from ${scope} scope.`);
  } else {
    console.error(`NG: ${name} is not registered.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

async function runDeployCommand(rest: string[]): Promise<void> {
  try {
    assertProFeature("deploy");
  } catch (err) {
    if (err instanceof ProFeatureError) {
      printProFeatureRequired();
      process.exit(6);
    }
    throw err;
  }

  const args = parseDeployArgs(rest);
  validateNameOrExit(args.name);

  const adapter = ADAPTERS.get(args.target);
  if (!adapter) {
    console.error("Unknown option. --target must be one of: cloudflare, vercel, github");
    process.exit(1);
  }

  const vault = createVault();
  await requireVaultAvailable(vault);

  const projectId = args.scope === "project" ? deriveProjectId(args.targetDir) : null;

  const result = await runDeploy(
    {
      vault,
      adapter,
      print: (line) => console.log(line),
      confirmProduction: (summary) => confirmExact(summary)
    },
    {
      name: args.name,
      scope: args.scope,
      projectId,
      projectDir: args.targetDir,
      env: args.env,
      dryRun: args.dryRun,
      force: args.force
    }
  );

  switch (result.kind) {
    case "cli-unavailable":
      process.exit(5);
      break;
    case "missing-secret":
      process.exit(1);
      break;
    case "dry-run":
      return;
    case "declined":
      process.exit(4);
      break;
    case "executed": {
      const ok = result.handoff.exitCode === 0;
      if (ok) {
        console.log(`OK: ${args.name} deployed to ${args.target} (${args.env}).`);
        return;
      }

      console.error(
        `NG: deploy to ${args.target} failed${result.handoff.timedOut ? " (timed out)" : ""}.`
      );
      const detail = result.handoff.stderrRedacted.trim() || result.handoff.stdoutRedacted.trim();
      if (detail) {
        console.error(detail);
      }
      if (args.target === "vercel" && !args.force) {
        console.error("If the secret already exists on Vercel, retry with --force.");
      }
      process.exit(1);
    }
  }
}

function parseDeployArgs(rest: string[]): DeployArgs {
  const positionals: string[] = [];
  let target: TargetId | null = null;
  let env: DeployEnv = "development";
  let scope: SecretScope = "project";
  let dryRun = false;
  let force = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--target") {
      target = readTargetValue(rest[++i]);
    } else if (arg === "--env") {
      env = readEnvValue(rest[++i]);
    } else if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      process.exit(1);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0 || positionals.length > 2 || !target) {
    console.error(
      "Usage: api-key-case deploy <NAME> --target <cloudflare|vercel|github> " +
        "[--env production|preview|development] [--scope user|project] [--dry-run] [--force] [path]"
    );
    process.exit(1);
  }

  const name = positionals[0];
  const targetDir = positionals.length > 1 ? resolve(positionals[1]) : process.cwd();

  return { name, target, env, scope, dryRun, force, targetDir };
}

function printProFeatureRequired(): void {
  console.error(
    "NG: deploy is a Pro feature (one-time purchase).\n" +
      "    Your existing scan/save/check/list/remove/targets tools remain available at no charge.\n" +
      `    Get a license: ${PURCHASE_URL}\n` +
      "    Then run: api-key-case license activate"
  );
}

function readTargetValue(value: string | undefined): TargetId {
  if (value && isTargetId(value)) {
    return value;
  }
  console.error("Unknown option. --target must be one of: cloudflare, vercel, github");
  process.exit(1);
}

function readEnvValue(value: string | undefined): DeployEnv {
  if (value && isDeployEnv(value)) {
    return value;
  }
  console.error("Unknown option. --env must be one of: production, preview, development");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

// Optional, for agents — the CLI remains the primary interface (CLAUDE.md
// section 2). stdout is reserved for JSON-RPC once connected, so nothing in
// this path may console.log; diagnostics, if any, go to stderr only.
async function runMcpCommand(rest: string[]): Promise<void> {
  const targetDir = rest.length > 0 ? resolve(rest[0]) : process.cwd();
  const server = createMcpServer(targetDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// targets
// ---------------------------------------------------------------------------

async function runTargetsCommand(rest: string[]): Promise<void> {
  const args = parseTargetsArgs(rest);
  const statuses = await inspectTargets(args.targetDir, ADAPTERS.values());

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          targets: statuses.map((status) => ({
            id: status.id,
            detected: status.detected,
            detectReason: status.detectReason,
            cliInstalled: status.cliInstalled,
            cliVersion: status.cliVersion ?? null,
            loggedIn: status.loggedIn,
            hint: status.hint ?? null
          }))
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Deploy targets for ${args.targetDir}:`);
  for (const status of statuses) {
    const detectLabel = status.detected ? `detected (${status.detectReason})` : "not detected";
    const cliLabel = !status.cliInstalled
      ? "cli: not installed"
      : `cli: ${ADAPTERS.get(status.id)?.cliCommand} ${status.cliVersion ?? "?"}, ` +
        (status.loggedIn ? "logged in" : `not logged in${status.hint ? ` (run: ${status.hint})` : ""}`);
    console.log(`  ${status.id.padEnd(11)} ${detectLabel.padEnd(28)} ${cliLabel}`);
  }
}

function parseTargetsArgs(rest: string[]): TargetsArgs {
  let targetDir = process.cwd();
  let json = false;

  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      process.exit(1);
    } else {
      targetDir = resolve(arg);
    }
  }

  return { targetDir, json };
}

// ---------------------------------------------------------------------------
// license
// ---------------------------------------------------------------------------

async function runLicenseCommand(rest: string[]): Promise<void> {
  const [sub, ...subRest] = rest;

  if (sub === "activate") {
    await runLicenseActivate(subRest);
    return;
  }

  if (sub === "status") {
    runLicenseStatus(subRest);
    return;
  }

  if (sub === "deactivate") {
    runLicenseDeactivate();
    return;
  }

  console.error("Usage: api-key-case license <activate|status|deactivate>");
  process.exit(1);
}

async function runLicenseActivate(rest: string[]): Promise<void> {
  if (rest.length !== 0) {
    console.error("Usage: api-key-case license activate");
    process.exit(1);
  }

  let purchaseKey: string;
  try {
    purchaseKey = await promptPurchaseLicenseKey();
  } catch {
    console.error("NG: purchase license key input requires an interactive terminal.");
    process.exit(1);
  }

  let status: Extract<ReturnType<typeof readLicenseStatus>, { plan: "pro" }>;
  try {
    status = await activatePurchaseLicense(purchaseKey);
  } catch {
    console.error("NG: license activation failed. Check the key and your network connection, then retry.");
    process.exit(1);
  }

  console.log(`OK: pro license activated (license ${status.entitlementId}).`);
}

function runLicenseStatus(rest: string[]): void {
  const json = rest.includes("--json");
  const status = readLicenseStatus();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (status.plan === "pro") {
    console.log(`plan: pro (license ${status.entitlementId}, issued ${status.issuedAt})`);
  } else {
    console.log("plan: free");
  }
}

function runLicenseDeactivate(): void {
  deactivateLicense();
  console.log("OK: license deactivated.");
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function readScopeValue(value: string | undefined): SecretScope {
  if (value === "user" || value === "project") {
    return value;
  }
  console.error("Unknown option.");
  process.exit(1);
}

function validateNameOrExit(name: string): void {
  try {
    assertValidSecretName(name);
  } catch (err) {
    if (err instanceof SecretNameError) {
      console.error(`NG: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function requireVaultAvailable(vault: { isAvailable(): Promise<boolean> }): Promise<void> {
  if (await vault.isAvailable()) {
    return;
  }

  console.error(
    "NG: no OS secret store is available on this system.\n" +
      "    macOS: Keychain should be available by default.\n" +
      "    Windows: Credential Manager should be available by default.\n" +
      "    Linux: install and unlock a Secret Service provider (e.g. gnome-keyring)."
  );
  process.exit(3);
}

function normalizePath(dir: string): string {
  return realpathSync(dir).replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// help / version
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`api-key-case

Usage:
  api-key-case scan [path] [--json] [--strict]
                            [--write-env-example] [--agent-report] [--force]
  api-key-case save <NAME> [--scope user|project] [--force]
  api-key-case check [NAME] [path] [--scope user|project] [--json] [--strict]
  api-key-case list [path] [--scope user|project] [--json]
  api-key-case remove <NAME> [--scope user|project] [--yes]
  api-key-case deploy <NAME> --target <cloudflare|vercel|github>
                       [--env production|preview|development]
                       [--scope user|project] [--dry-run] [--force] [path]
  api-key-case targets [path] [--json]
  api-key-case mcp [path]
  api-key-case license activate
  api-key-case license status [--json]
  api-key-case license deactivate

Commands:
  scan       Check .env safety, required secret names, and likely leaked tokens.
  save       Store a secret value in the OS secret store (interactive, hidden input).
  check      Report registered/missing status for one secret or all secrets from scan.
  list       List registered secret names and metadata (never values).
  remove     Delete a secret from the OS secret store.
  deploy     Send a stored secret to Cloudflare/Vercel/GitHub via their official CLI.
             Pro feature (one-time purchase) — the current core feature set is free.
  targets    Show which deploy targets are detected and whether their CLI is ready.
  mcp        Start an MCP server (stdio) exposing status-only tools to an agent.
             Optional, for agents — the CLI remains the primary interface.
  license    Exchange a Lemon Squeezy purchase key once, then check/deactivate
             the local Pro license. Pro checks remain fully offline afterward.
  version    Print package version.
  help       Print this help.

Security boundary:
  This CLI reports only status, names, file locations, and redacted findings.
  It does not print, export, or write real secret values.
  Secret values are typed by a human, stored in the OS secret store,
  and never printed, exported, or written to files by this CLI.
  deploy reads a value only to hand it to the target CLI's stdin, once, and
  never places it in argv, an environment variable, a file, or a log line.
  Deploying to production always requires typing "yes" at an interactive
  prompt; there is no flag to skip this.

Generated files:
  --write-env-example  Write an empty-value .env.example.
  --agent-report       Write agent-safe context and prompt Markdown files.
  --force              Replace generated files that already exist (scan),
                        overwrite an existing secret (save), or replace an
                        existing platform value first (deploy, vercel only).

Exit codes:
  0  success (including a completed --dry-run)
  1  general error (validation, not registered, target CLI error)
  2  --strict found warnings/missing secrets (scan, check)
  3  no OS secret store is available
  4  production confirmation was not given
  5  the target's CLI is not installed or not logged in
  6  a Pro license is required (deploy)
`);
}

function printVersion(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")) as { version: string };
  console.log(pkg.version);
}
