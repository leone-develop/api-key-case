import { spawnSync } from "node:child_process";

export type GitState = {
  available: boolean;
  isRepo: boolean;
  trackedEnvFiles: string[];
  historyEnvFiles: string[];
};

const ENV_PATHSPECS = [":(glob)**/.env", ":(glob)**/.env.*"];

export function inspectGit(rootDir: string): GitState {
  const base: GitState = {
    available: false,
    isRepo: false,
    trackedEnvFiles: [],
    historyEnvFiles: []
  };

  const version = runGit(rootDir, ["--version"]);
  if (version.status !== 0) {
    return base;
  }

  base.available = true;

  const repo = runGit(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  if (repo.status !== 0 || repo.stdout.trim() !== "true") {
    return base;
  }

  base.isRepo = true;
  base.trackedEnvFiles = splitZero(
    runGit(rootDir, ["ls-files", "-z", "--", ...ENV_PATHSPECS]).stdout
  )
    .filter(isRealEnvFile);

  const history = runGit(rootDir, [
    "log",
    "--all",
    "--name-only",
    "--pretty=format:",
    "--",
    ...ENV_PATHSPECS
  ]);
  base.historyEnvFiles = unique(
    history.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(isRealEnvFile)
  );

  return base;
}

// Used by the github deploy adapter (phase-3-deploy.md §6.3) to detect a
// GitHub remote without needing its own git-invocation code.
export function getRemoteUrl(rootDir: string, remoteName = "origin"): string | null {
  const result = runGit(rootDir, ["remote", "get-url", remoteName]);
  if (result.status !== 0) {
    return null;
  }
  const url = result.stdout.trim();
  return url.length > 0 ? url : null;
}

function runGit(cwd: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });

  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : ""
  };
}

function splitZero(value: string): string[] {
  return value.split("\0").map((part) => part.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isRealEnvFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (!normalized || normalized.endsWith(".example")) {
    return false;
  }

  const name = normalized.split("/").pop() ?? "";
  return name === ".env" || name.startsWith(".env.");
}
