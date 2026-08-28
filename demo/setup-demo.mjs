// Builds the throwaway project that the demo scans.
//
// Everything here is fabricated. The sandbox lives in the OS temp directory,
// never inside this repository, and cleanup-demo.mjs deletes it. The "leaked"
// token is a made-up string that only exists so the scanner has something real
// to find — and the scanner prints ***REDACTED*** for it either way.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isMain } from "./lib/main.mjs";
import { SANDBOX_DIR, SANDBOX_ROOT } from "./config.mjs";

const FILES = {
  "package.json": `{
  "name": "demo-checkout",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
`,

  // Fabricated placeholders only. No value here is, or resembles, a credential.
  ".env": `# Demo fixture for the API Key Case demo video. Fabricated values only.
OPENAI_API_KEY=replace-me-demo-placeholder
RESEND_API_KEY=replace-me-demo-placeholder
`,

  ".env.example": `OPENAI_API_KEY=
RESEND_API_KEY=
`,

  "wrangler.toml": `name = "demo-checkout"
main = "src/index.ts"
compatibility_date = "2026-01-01"
`,

  "vercel.json": `{
  "framework": null
}
`,

  "src/index.ts": `import { summarize } from "./summary.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const summary = await summarize(await request.text());
    return Response.json({ summary });
  }
};
`,

  "src/summary.ts": `// TODO: move this to the environment before shipping.
const OPENAI_API_KEY = "sk-demoDEMOdemoDEMOdemo0123456789";

export async function summarize(text: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: \`Bearer \${OPENAI_API_KEY}\` },
    body: JSON.stringify({ model: "gpt-5", input: text })
  });
  return (await response.json()).output_text;
}
`,

  "src/mailer.ts": `export async function notify(to: string, body: string): Promise<void> {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: \`Bearer \${process.env.RESEND_API_KEY}\` },
    body: JSON.stringify({ to, text: body })
  });
}
`
};

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// setupSandbox() deletes its target before rebuilding it, so the target is
// pinned to one directory under the sandbox root and nothing else. A wrong
// path here would delete a real directory.
function assertSafeSandbox(dir) {
  const target = resolve(dir);
  const root = resolve(SANDBOX_ROOT);
  const rel = relative(root, target);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (!inside) {
    throw new Error(`refusing to build the sandbox outside ${root}: ${target}`);
  }
  if (resolve(root) === resolve(tmpdir())) {
    throw new Error("refusing to use the temp directory itself as the sandbox root");
  }
}

export function setupSandbox(dir = SANDBOX_DIR) {
  assertSafeSandbox(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  for (const [relativePath, content] of Object.entries(FILES)) {
    const absolute = join(dir, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  // A fresh repo with its own identity, so the demo never borrows the
  // machine's git config. `.env` is committed on purpose: that mistake is
  // what `scan` is for.
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.name", "Demo"], dir);
  git(["config", "user.email", "demo@example.com"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "Initial commit"], dir);

  return dir;
}

export function teardownSandbox(dir = SANDBOX_DIR) {
  assertSafeSandbox(dir);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  console.log("sandbox:", setupSandbox());
}
