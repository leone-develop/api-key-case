import { Entry } from "@napi-rs/keyring";
import { toAccount, VAULT_SERVICE } from "./naming.js";
import type { SecretRef, Vault } from "./types.js";

const PROBE_ACCOUNT = "v1|probe";

export class KeyringVault implements Vault {
  readonly backendName = "keyring";

  async isAvailable(): Promise<boolean> {
    try {
      const entry = new Entry(VAULT_SERVICE, PROBE_ACCOUNT);
      entry.setPassword("probe");
      entry.deleteCredential();
      return true;
    } catch {
      return false;
    }
  }

  async setSecret(ref: SecretRef, value: string): Promise<void> {
    const entry = new Entry(VAULT_SERVICE, toAccount(ref));
    try {
      entry.setPassword(value);
    } catch (err) {
      throw sanitizeError(err, value);
    }
  }

  async hasSecret(ref: SecretRef): Promise<boolean> {
    const entry = new Entry(VAULT_SERVICE, toAccount(ref));
    let found: boolean;
    try {
      found = entry.getPassword() !== null;
    } catch (err) {
      throw sanitizeError(err, undefined);
    }
    return found;
  }

  async deleteSecret(ref: SecretRef): Promise<boolean> {
    const entry = new Entry(VAULT_SERVICE, toAccount(ref));
    try {
      return entry.deleteCredential();
    } catch (err) {
      throw sanitizeError(err, undefined);
    }
  }
}

function sanitizeError(err: unknown, value: string | undefined): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (value && message.includes(value)) {
    return new Error("Vault backend error (message redacted to avoid leaking a secret value).");
  }
  return err instanceof Error ? err : new Error(message);
}
