export type SecretScope = "user" | "project"; // NOTE: "team" is a planned future scope; do not implement.

export interface SecretRef {
  name: string; // validated: ^[A-Z][A-Z0-9_]{0,127}$
  scope: SecretScope;
  projectId: string | null; // null when scope === "user"
}

// Deliberately has NO method that returns a secret value. Do not add one.
export interface Vault {
  readonly backendName: string;
  isAvailable(): Promise<boolean>;
  setSecret(ref: SecretRef, value: string): Promise<void>;
  hasSecret(ref: SecretRef): Promise<boolean>;
  deleteSecret(ref: SecretRef): Promise<boolean>; // false = did not exist
}

export class VaultUnavailableError extends Error {}
export class SecretNameError extends Error {}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export function assertValidSecretName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new SecretNameError(
      `Invalid secret name: ${name}. Names must match ${NAME_PATTERN.source}.`
    );
  }
}
