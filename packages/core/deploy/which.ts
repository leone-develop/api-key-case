import { accessSync, constants, existsSync } from "node:fs";
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { delimiter, join } from "node:path";

export interface ResolvedCli {
  absolutePath: string;
  isWindowsScript: boolean; // .cmd / .bat — needs the cmd.exe wrapper below
}

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"];

// Resolves a CLI binary from PATH only (never node_modules/.bin — see
// phase-3-deploy.md §2-13: a repo could ship a fake wrangler/vercel/gh that
// steals a secret via stdin). `pathOverride` exists only so tests can point
// this at a fixture directory without mutating process.env.PATH.
export function resolveCli(command: string, pathOverride?: string): ResolvedCli | null {
  const pathValue = pathOverride ?? process.env.PATH ?? process.env.Path ?? "";
  const dirs = pathValue.split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    if (process.platform === "win32") {
      for (const ext of WINDOWS_EXTENSIONS) {
        const candidate = join(dir, `${command}${ext}`);
        if (existsSync(candidate)) {
          return { absolutePath: candidate, isWindowsScript: ext === ".cmd" || ext === ".bat" };
        }
      }
    } else {
      const candidate = join(dir, command);
      if (existsSync(candidate) && isExecutable(candidate)) {
        return { absolutePath: candidate, isWindowsScript: false };
      }
    }
  }

  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Node 20+ throws EINVAL spawning a .cmd/.bat directly with shell:false
// (hardening for CVE-2024-27980). Workaround: invoke through cmd.exe /d /s /c.
// `args` MUST already be validated tokens only (secret NAME regex, closed
// DeployEnv enum, static CLI subcommand literals) — never add an
// unvalidated string to this argv, since cmd.exe re-parses it.
export function spawnResolvedCli(
  resolved: ResolvedCli,
  args: string[],
  options: SpawnOptionsWithoutStdio
): ChildProcess {
  if (resolved.isWindowsScript) {
    return spawn("cmd.exe", ["/d", "/s", "/c", resolved.absolutePath, ...args], {
      ...options,
      shell: false
    });
  }
  return spawn(resolved.absolutePath, args, { ...options, shell: false });
}
