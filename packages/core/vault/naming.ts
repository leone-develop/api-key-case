import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { SecretRef } from "./types.js";

export const VAULT_SERVICE = "api-key-case";

export function deriveProjectId(targetDir: string): string {
  const real = realpathSync(targetDir);
  const normalized = real.replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function toAccount(ref: SecretRef): string {
  const scopeId = ref.scope === "user" ? "-" : ref.projectId ?? "-";
  return `v1|${ref.scope}|${scopeId}|${ref.name}`;
}
