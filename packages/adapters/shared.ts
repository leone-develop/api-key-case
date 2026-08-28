import { spawnSync } from "node:child_process";
import { resolveCli } from "../core/deploy/which.js";

export interface CliInvocation {
  installed: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

// Synchronous helper for CLI presence/login checks (--version, whoami, etc).
// Never touches a secret value — only static, hardcoded argv tokens are
// passed in by callers.
export function runCliSync(command: string, args: string[], timeoutMs = 15_000): CliInvocation {
  const resolved = resolveCli(command);
  if (!resolved) {
    return { installed: false, status: null, stdout: "", stderr: "" };
  }

  const result = resolved.isWindowsScript
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", resolved.absolutePath, ...args], {
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        shell: false
      })
    : spawnSync(resolved.absolutePath, args, {
        timeout: timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        shell: false
      });

  return {
    installed: true,
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : ""
  };
}

export function extractVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0];
}
