import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CliStatus, DeployEnv, DeployPlan, DeployTarget, DetectResult } from "../core/deploy/types.js";
import { extractVersion, runCliSync } from "./shared.js";

export class VercelAdapter implements DeployTarget {
  readonly id = "vercel" as const;
  readonly cliCommand = "vercel";

  async detect(projectDir: string): Promise<DetectResult> {
    if (existsSync(join(projectDir, ".vercel", "project.json"))) {
      return { detected: true, reason: ".vercel/project.json (linked)" };
    }
    if (existsSync(join(projectDir, "vercel.json"))) {
      return { detected: true, reason: "vercel.json (not yet linked; run: vercel link)" };
    }
    return { detected: false, reason: "no .vercel/project.json or vercel.json found" };
  }

  async checkCli(): Promise<CliStatus> {
    const version = runCliSync("vercel", ["--version"]);
    if (!version.installed) {
      return { installed: false, loggedIn: false, hint: "npm i -g vercel" };
    }

    const who = runCliSync("vercel", ["whoami"]);
    const loggedIn = who.status === 0;
    return {
      installed: true,
      version: extractVersion(version.stdout),
      loggedIn,
      hint: loggedIn ? undefined : "vercel login"
    };
  }

  planDeploy(name: string, env: DeployEnv, opts: { force: boolean }): DeployPlan {
    const argv = ["vercel", "env", "add", name, env];
    const plan: DeployPlan = {
      argv,
      valueVia: "stdin",
      displayCommand: argv.join(" "),
      overwriteWarning: false
    };

    if (opts.force) {
      const removeArgv = ["vercel", "env", "rm", name, env, "--yes"];
      plan.preSteps = [
        {
          argv: removeArgv,
          valueVia: "stdin",
          displayCommand: `${removeArgv.join(" ")}   (removes existing value first)`,
          overwriteWarning: true
        }
      ];
    }

    return plan;
  }

  manualSteps(name: string, env: DeployEnv): string[] {
    return [
      "npm i -g vercel",
      "vercel login   (then: vercel link)",
      `vercel env add ${name} ${env}   (paste the value when prompted)`
    ];
  }
}
