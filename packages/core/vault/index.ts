import { KeyringVault } from "./keyring.js";
import { removeRegistryEntry, upsertRegistryEntry, readRegistry, type RegistryEntry } from "./registry.js";
import type { SecretRef, Vault } from "./types.js";

export function createVault(): Vault {
  return new KeyringVault();
}

export async function saveSecret(
  vault: Vault,
  ref: SecretRef,
  value: string,
  projectPath: string | null
): Promise<void> {
  await vault.setSecret(ref, value);
  upsertRegistryEntry({
    name: ref.name,
    scope: ref.scope,
    projectId: ref.projectId,
    projectPath
  });
}

export async function removeSecret(vault: Vault, ref: SecretRef): Promise<boolean> {
  const existed = await vault.deleteSecret(ref);
  removeRegistryEntry({ name: ref.name, scope: ref.scope, projectId: ref.projectId });
  return existed;
}

export type VaultListEntry = RegistryEntry & { storeStatus: "registered" | "stale" };

export async function listSecrets(
  vault: Vault,
  scope: SecretRef["scope"],
  projectId: string | null
): Promise<VaultListEntry[]> {
  const entries = readRegistry().filter(
    (entry) => entry.scope === scope && entry.projectId === projectId
  );

  const withStatus: VaultListEntry[] = [];
  for (const entry of entries) {
    const registered = await vault.hasSecret({
      name: entry.name,
      scope: entry.scope,
      projectId: entry.projectId
    });
    withStatus.push({ ...entry, storeStatus: registered ? "registered" : "stale" });
  }

  return withStatus;
}

export * from "./types.js";
export * from "./naming.js";
export * from "./registry.js";
