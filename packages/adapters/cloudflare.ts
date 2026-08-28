import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CliStatus, DeployEnv, DeployPlan, DeployTarget, DetectResult } from "../core/deploy/types.js";
import { extractVersion, runCliSync } from "./shared.js";

const CONFIG_FILES = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];

export class CloudflareAdapter implements DeployTarget {
  readonly id = "cloudflare" as const;
  readonly cliCommand = "wrangler";

  async detect(projectDir: string): Promise<DetectResult> {
    for (const file of CONFIG_FILES) {
      if (existsSync(join(projectDir, file))) {
        return { detected: true, reason: file };
      }
    }
    return { detected: false, reason: "no wrangler.toml/json/jsonc found" };
  }

  async checkCli(): Promise<CliStatus> {
    const version = runCliSync("wrangler", ["--version"]);
    if (!version.installed) {
      return { installed: false, loggedIn: false, hint: "npm i -g wrangler" };
    }

    const who = runCliSync("wrangler", ["whoami", "--json"]);
    const loggedIn = who.status === 0;
    return {
      installed: true,
      version: extractVersion(version.stdout),
      loggedIn,
      hint: loggedIn ? undefined : "wrangler login"
    };
  }

  planDeploy(name: string, env: DeployEnv, opts: { force: boolean }): DeployPlan {
    void opts; // wrangler always overwrites; --force has no additional effect here.
    const argv =
      env === "production"
        ? ["wrangler", "secret", "put", name]
        : ["wrangler", "secret", "put", name, "--env", env];

    return {
      argv,
      valueVia: "stdin",
      displayCommand: argv.join(" "),
      overwriteWarning: true
    };
  }

  // Must branch on env exactly as planDeploy does, so the steps we hand a user
  // target the same wrangler environment the run they asked for would have.
  manualSteps(name: string, env: DeployEnv): string[] {
    const put =
      env === "production"
        ? `wrangler secret put ${name}   (paste the value when prompted)`
        : `wrangler secret put ${name} --env ${env}   (paste the value when prompted; needs a "${env}" environment in wrangler.toml)`;

    return ["npm i -g wrangler", "wrangler login", put];
  }
}
