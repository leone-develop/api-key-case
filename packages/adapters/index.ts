import type { DeployTarget, TargetId } from "../core/deploy/types.js";
import { CloudflareAdapter } from "./cloudflare.js";
import { GitHubAdapter } from "./github.js";
import { VercelAdapter } from "./vercel.js";

// Closed allowlist (phase-3-deploy.md §2-11). Do not add a 4th entry, and
// do not make this configurable from a file or env var — CLAUDE.md §3-4.
export const ADAPTERS: ReadonlyMap<TargetId, DeployTarget> = new Map<TargetId, DeployTarget>([
  ["cloudflare", new CloudflareAdapter()],
  ["vercel", new VercelAdapter()],
  ["github", new GitHubAdapter()]
]);

export function isTargetId(value: string): value is TargetId {
  return ADAPTERS.has(value as TargetId);
}
