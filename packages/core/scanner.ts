import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { inspectGit, type GitState } from "./git.js";
import { checkGitignore, isPathIgnored, type GitignoreCheck } from "./gitignore.js";
import { findSecretLikeTokens, type SecretFinding } from "./patterns.js";

export type ScanOptions = {
  targetDir: string;
  writeEnvExample?: boolean;
  agentReport?: boolean;
  force?: boolean;
};

export type EnvFileState = {
  file: string;
  ignored: boolean;
  tracked: boolean;
  seenInHistory: boolean;
};

export type ScanReport = {
  targetDir: string;
  generatedAt: string;
  gitignore: GitignoreCheck;
  git: GitState;
  envFiles: EnvFileState[];
  requiredSecrets: string[];
  secretUsages: SecretUsage[];
  secretFindings: SecretFinding[];
  envExample: {
    path: string;
    content: string;
    exists: boolean;
    written: boolean;
    reason?: string;
  };
  agentReport: {
    requested: boolean;
    files: GeneratedFileState[];
  };
  warnings: string[];
};

export type SecretUsage = {
  name: string;
  files: string[];
};

export type GeneratedFileState = {
  path: string;
  exists: boolean;
  written: boolean;
  reason?: string;
};

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  "out",
  "build",
  "vendor"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".toml",
  ".yaml",
  ".yml"
]);

export function scanProject(options: ScanOptions): ScanReport {
  const targetDir = resolve(options.targetDir);
  const gitignore = checkGitignore(targetDir);
  const git = inspectGit(targetDir);
  const files = walkFiles(targetDir);
  const envFiles = inspectEnvFiles(targetDir, files, git);
  const sourceFiles = files.filter((file) => shouldScanTextFile(file));
  const { requiredSecrets, secretUsages } = collectRequiredSecrets(targetDir, sourceFiles);
  const secretFindings = sourceFiles.flatMap((file) => {
    const rel = toRelative(targetDir, file);
    return findSecretLikeTokens(rel, readFileSync(file, "utf8"));
  });
  const envExampleContent = generateEnvExample(requiredSecrets);
  const envExamplePath = join(targetDir, ".env.example");
  const shouldWriteEnvExample = Boolean(options.writeEnvExample || options.agentReport);
  const envExampleState = writeGeneratedFile({
    absolutePath: envExamplePath,
    relativePath: ".env.example",
    content: envExampleContent,
    requested: shouldWriteEnvExample && requiredSecrets.length > 0,
    force: Boolean(options.force),
    emptyReason: requiredSecrets.length === 0
      ? "not generated because no required secrets were detected"
      : undefined
  });
  const agentReportFiles = options.agentReport
    ? writeAgentReport(targetDir, requiredSecrets, secretUsages, envFiles, Boolean(options.force))
    : [];

  return {
    targetDir,
    generatedAt: new Date().toISOString(),
    gitignore,
    git,
    envFiles,
    requiredSecrets,
    secretUsages,
    secretFindings,
    envExample: {
      path: ".env.example",
      content: envExampleContent,
      exists: envExampleState.exists,
      written: envExampleState.written,
      reason: envExampleState.reason
    },
    agentReport: {
      requested: Boolean(options.agentReport),
      files: agentReportFiles.map(({ content: _content, ...file }) => file)
    },
    warnings: buildWarnings(gitignore, git, envFiles, secretFindings)
  };
}

function walkFiles(rootDir: string): string[] {
  const files: string[] = [];

  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          visit(join(dir, entry.name));
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(join(dir, entry.name));
      }
    }
  }

  visit(rootDir);
  return files;
}

function inspectEnvFiles(
  rootDir: string,
  files: string[],
  git: GitState
): EnvFileState[] {
  const tracked = new Set(git.trackedEnvFiles);
  const history = new Set(git.historyEnvFiles);

  return files
    .map((file) => toRelative(rootDir, file))
    .filter(isEnvFile)
    .map((file) => ({
      file,
      ignored: isPathIgnored(rootDir, file),
      tracked: tracked.has(file),
      seenInHistory: history.has(file)
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function collectRequiredSecrets(
  rootDir: string,
  files: string[]
): { requiredSecrets: string[]; secretUsages: SecretUsage[] } {
  const names = new Set<string>();
  const usages = new Map<string, Set<string>>();
  const envExample = join(rootDir, ".env.example");

  if (existsSync(envExample)) {
    for (const name of parseEnvExample(readFileSync(envExample, "utf8"))) {
      names.add(name);
    }
  }

  for (const file of files) {
    const rel = toRelative(rootDir, file);
    if (isEnvFile(rel)) {
      continue;
    }

    const content = readFileSync(file, "utf8");
    for (const name of findEnvReferences(content)) {
      names.add(name);
      const filesForName = usages.get(name) ?? new Set<string>();
      filesForName.add(rel);
      usages.set(name, filesForName);
    }
  }

  const requiredSecrets = [...names].sort();
  return {
    requiredSecrets,
    secretUsages: requiredSecrets.map((name) => ({
      name,
      files: [...(usages.get(name) ?? [])].sort()
    }))
  };
}

function parseEnvExample(content: string): string[] {
  const names: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/);
    if (match) {
      names.push(match[1]);
    }
  }

  return names;
}

function findEnvReferences(content: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]+)/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
    /\bDeno\.env\.get\(["']([A-Z][A-Z0-9_]+)["']\)/g,
    /\benv\.([A-Z][A-Z0-9_]+)/g
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      names.add(match[1]);
    }
  }

  return [...names];
}

function generateEnvExample(requiredSecrets: string[]): string {
  const lines = [
    "# Generated by api-key-case.",
    "# Fill values locally. Do not commit real secret values.",
    ""
  ];

  for (const name of requiredSecrets) {
    lines.push(`${name}=`);
  }

  return `${lines.join("\n")}\n`;
}

type GeneratedFileWithContent = GeneratedFileState & {
  content: string;
};

function writeGeneratedFile(options: {
  absolutePath: string;
  relativePath: string;
  content: string;
  requested: boolean;
  force: boolean;
  emptyReason?: string;
}): GeneratedFileState {
  const exists = existsSync(options.absolutePath);

  if (!options.requested) {
    return {
      path: options.relativePath,
      exists,
      written: false,
      reason: options.emptyReason
    };
  }

  if (exists && !options.force) {
    return {
      path: options.relativePath,
      exists: true,
      written: false,
      reason: "existing file preserved; use --force to replace it"
    };
  }

  writeFileSync(options.absolutePath, options.content, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx"
  });

  return {
    path: options.relativePath,
    exists: true,
    written: true
  };
}

function writeAgentReport(
  targetDir: string,
  requiredSecrets: string[],
  secretUsages: SecretUsage[],
  envFiles: EnvFileState[],
  force: boolean
): GeneratedFileWithContent[] {
  const generated = [
    {
      path: "AGENT_CONTEXT.safe.md",
      content: generateAgentContext(requiredSecrets, secretUsages, envFiles)
    },
    {
      path: "AI_SAFE_PROMPT.md",
      content: generateSafePrompt()
    }
  ];

  return generated.map((file) => ({
    ...writeGeneratedFile({
      absolutePath: join(targetDir, file.path),
      relativePath: file.path,
      content: file.content,
      requested: true,
      force
    }),
    content: file.content
  }));
}

function generateAgentContext(
  requiredSecrets: string[],
  secretUsages: SecretUsage[],
  envFiles: EnvFileState[]
): string {
  const lines = [
    "# Agent-safe project context",
    "",
    "> Generated locally by API Key Case. Review this file before sharing it.",
    "> It contains environment variable names and file locations, never secret values.",
    "",
    "## Required environment variables",
    ""
  ];

  if (requiredSecrets.length === 0) {
    lines.push("- None detected.");
  } else {
    for (const name of requiredSecrets) {
      const usage = secretUsages.find((item) => item.name === name);
      const locations = usage && usage.files.length > 0
        ? usage.files.map(formatMarkdownPath).join(", ")
        : "declared in `.env.example`";
      lines.push(`- \`${name}\` — ${locations}`);
    }
  }

  lines.push(
    "",
    "## Files the agent must not read",
    ""
  );

  if (envFiles.length === 0) {
    lines.push("- `.env` and every `.env.*` file except example templates.");
  } else {
    for (const envFile of envFiles) {
      lines.push(`- ${formatMarkdownPath(envFile.file)}`);
    }
  }

  lines.push(
    "",
    "## Implementation constraints",
    "",
    "- Do not request, read, print, log, serialize, or commit real secret values.",
    "- Use only the environment variable names listed above.",
    "- Keep API integrations behind an adapter or service boundary.",
    "- Use mocks or fakes in automated tests; do not call real APIs.",
    "- Error messages may name a missing variable but must never include its value.",
    "- A human must configure real values and perform the final local integration check.",
    ""
  );

  return lines.join("\n");
}

function formatMarkdownPath(value: string): string {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/`/g, "'");
  return `\`${sanitized}\``;
}

function generateSafePrompt(): string {
  return `# Safe prompt for an AI coding agent

Implement the requested API integration in this repository.

Important constraints:

- No real API keys or secret values will be provided.
- Do not read \`.env\`, \`.env.local\`, or other files that may contain secrets.
- Use only environment variable names listed in \`.env.example\` or \`AGENT_CONTEXT.safe.md\`.
- Never place secret values in logs, errors, test output, README files, JSON, screenshots, or comments.
- When configuration is missing, report only the variable name, for example: \`OPENAI_API_KEY is required\`.
- Put API calls behind an adapter or service boundary.
- Use mocks or fakes in automated tests. Do not call real APIs during tests.
- Keep values in \`.env.example\` empty.
- Run unit tests and the build after implementation.
- Finish with steps for a human to perform the final local check using their own credentials.
`;
}

function buildWarnings(
  gitignore: GitignoreCheck,
  git: GitState,
  envFiles: EnvFileState[],
  findings: SecretFinding[]
): string[] {
  const warnings: string[] = [];

  if (!gitignore.hasGitignore) {
    warnings.push("No .gitignore file found.");
  } else {
    if (!gitignore.ignoresDotEnv) {
      warnings.push(".env is not ignored.");
    }
    if (!gitignore.ignoresDotEnvVariants) {
      warnings.push(".env variants such as .env.local are not ignored.");
    }
  }

  for (const envFile of envFiles) {
    if (envFile.tracked) {
      warnings.push(`${envFile.file} is tracked by git.`);
    }
    if (envFile.seenInHistory) {
      warnings.push(`${envFile.file} appears in git history.`);
    }
  }

  if (!git.available) {
    warnings.push("Git is not available; tracked/history checks were skipped.");
  } else if (!git.isRepo) {
    warnings.push("Target is not a git work tree; tracked/history checks were skipped.");
  }

  if (findings.length > 0) {
    warnings.push(`${findings.length} possible secret value(s) found outside ignored env files.`);
  }

  return warnings;
}

function shouldScanTextFile(file: string): boolean {
  if (isEnvFile(file)) {
    return false;
  }

  const ext = extname(file);
  if (!TEXT_EXTENSIONS.has(ext)) {
    return false;
  }

  return statSync(file).size <= 1024 * 1024;
}

function isEnvFile(file: string): boolean {
  const name = file.replace(/\\/g, "/").split("/").pop() ?? "";
  return (name === ".env" || name.startsWith(".env.")) && !name.endsWith(".example");
}

function toRelative(rootDir: string, file: string): string {
  return relative(rootDir, file).replace(/\\/g, "/");
}
