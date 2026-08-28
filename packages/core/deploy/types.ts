export type TargetId = "cloudflare" | "vercel" | "github";
export type DeployEnv = "production" | "preview" | "development";

export interface DeployPlan {
  argv: string[]; // argv[0] = CLI command name ("wrangler", etc). Never contains a secret value.
  valueVia: "stdin";
  displayCommand: string;
  overwriteWarning: boolean;
  preSteps?: DeployPlan[];
}

export interface DetectResult {
  detected: boolean;
  reason: string;
}

export interface CliStatus {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  hint?: string;
}

export interface DeployTarget {
  readonly id: TargetId;
  readonly cliCommand: string;
  detect(projectDir: string): Promise<DetectResult>;
  checkCli(): Promise<CliStatus>;
  planDeploy(name: string, env: DeployEnv, opts: { force: boolean }): DeployPlan;
  manualSteps(name: string, env: DeployEnv): string[];
}

const ENV_VALUES: readonly DeployEnv[] = ["production", "preview", "development"];

export function isDeployEnv(value: string): value is DeployEnv {
  return (ENV_VALUES as readonly string[]).includes(value);
}
