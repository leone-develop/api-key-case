import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type GitignoreCheck = {
  hasGitignore: boolean;
  ignoresDotEnv: boolean;
  ignoresDotEnvVariants: boolean;
};

export function checkGitignore(rootDir: string): GitignoreCheck {
  const file = join(rootDir, ".gitignore");
  if (!existsSync(file)) {
    return {
      hasGitignore: false,
      ignoresDotEnv: false,
      ignoresDotEnvVariants: false
    };
  }

  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  return {
    hasGitignore: true,
    ignoresDotEnv: isPathIgnored(rootDir, ".env", lines),
    ignoresDotEnvVariants:
      isPathIgnored(rootDir, ".env.local", lines) &&
      isPathIgnored(rootDir, ".env.production", lines)
  };
}

export function isPathIgnored(rootDir: string, file: string, knownPatterns?: string[]): boolean {
  const gitResult = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", file], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });

  if (gitResult.status === 0) {
    return true;
  }

  if (gitResult.status === 1) {
    return false;
  }

  const patterns = knownPatterns ?? readPatterns(rootDir);
  return isIgnoredByPatterns(file, patterns);
}

function readPatterns(rootDir: string): string[] {
  const path = join(rootDir, ".gitignore");
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function isIgnoredByPatterns(file: string, patterns: string[]): boolean {
  let ignored = false;

  for (const rawPattern of patterns) {
    const negated = rawPattern.startsWith("!");
    const pattern = negated ? rawPattern.slice(1) : rawPattern;

    if (matches(file, pattern)) {
      ignored = !negated;
    }
  }

  return ignored;
}

function matches(file: string, pattern: string): boolean {
  const normalizedFile = file.replace(/\\/g, "/");
  let normalizedPattern = pattern.replace(/\\/g, "/");

  if (normalizedPattern.startsWith("/")) {
    normalizedPattern = normalizedPattern.slice(1);
  }

  const hasSlash = normalizedPattern.includes("/");
  const candidate = hasSlash
    ? normalizedFile
    : normalizedFile.split("/").pop() ?? normalizedFile;
  const regex = globToRegex(normalizedPattern);
  return regex.test(candidate) || (!hasSlash && regex.test(normalizedFile));
}

function globToRegex(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`);
}
