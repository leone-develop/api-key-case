# tools/

Issuer-only recovery scripts. They are not part of the normal Lemon Squeezy
sales flow or the published npm package.

## issue-license.mjs

Issues Pro license keys for the `deploy` gate (`docs/design/phase-5-license.md`).

```sh
# One-time setup: generate the signing keypair. <output-dir> must be
# outside this repository (the script refuses otherwise).
node tools/issue-license.mjs --keygen ../akc-license-keys

# Emergency/manual recovery only (not normal per-order fulfillment).
node tools/issue-license.mjs --key ../akc-license-keys/license-private.pem --entitlement recovery_20260702_001
# -> prints AKC1.... to stdout.
```

## convert-signing-key.mjs

Converts the PKCS#8 PEM signing key to the single-line base64 DER form that
`api-key-case save` accepts, so the live Worker's `AKC_ED25519_PRIVATE_KEY`
can be placed through the product itself instead of by hand.

`<path-to-private-key.pem>` below is a placeholder to replace with the path
of the existing issuer private-key file. It is not a directory or filename to
create literally. If the existing key cannot be found, stop rather than
silently generating a replacement: a replacement also requires rotating the
public key embedded in the CLI and reissuing every affected license.

```sh
# Windows
node tools/convert-signing-key.mjs <path-to-private-key.pem> | clip
# macOS
node tools/convert-signing-key.mjs <path-to-private-key.pem> | pbcopy
```

It refuses to write to a terminal, refuses key paths inside the repo, and
verifies the key against `EMBEDDED_PUBLIC_KEY_PEM` before emitting anything.
Run `npm run build` first — the verification imports `dist/core/license.js`.

Never pipe this command's output through an AI agent, a chat window, or a
file inside the repository.

Record the real key location and its backup location in a private operator
record such as a password manager. Never put the machine-specific path or the
key material in this public repository.

## Installing a maintainer license (bootstrap)

`api-key-case license activate` is the *buyer* path only: it prompts for a
Lemon Squeezy purchase key and exchanges it online at `LICENSE_EXCHANGE_URL`.
It cannot install a self-issued `AKC1`, and it is unusable before the live
exchange Worker exists — which is exactly when the maintainer needs `deploy`
in order to provision that Worker's secrets.

Place a self-issued key directly instead:

```sh
node tools/issue-license.mjs --key <path-to-private-key.pem> --entitlement maintainer_<YYYYMMDD>
# copy the printed AKC1... line into:
#   Windows  %USERPROFILE%\.api-key-case\license.key
#   Unix     ~/.api-key-case/license.key

api-key-case license status   # must print: plan: pro (license maintainer_...)
```

The file holds one `AKC1` line; create `.api-key-case/` if it does not exist,
and keep the file owner-readable only (`chmod 600` on Unix). `license status`
performs the same Ed25519 verification as `deploy`, so a truncated or
mistyped paste fails closed as `plan: free` rather than half-working.
`api-key-case license deactivate` removes the file.

## Key management

- `license-private.pem` never lives in this repository, the npm package, or CI. Store it in a password manager or an encrypted, non-repo location.
- The corresponding public key is embedded as a source constant in `packages/core/license.ts` (`EMBEDDED_PUBLIC_KEY_PEM`).
- Normal sales use `workers/license-exchange`; this script is retained for controlled recovery and testing.
- There is no revocation list or periodic revalidation. A key issued once verifies offline.

## Recovery if the private key is lost or compromised

1. Run `--keygen` again to generate a new keypair.
2. Replace `EMBEDDED_PUBLIC_KEY_PEM` in `packages/core/license.ts` with the new public key, bump the package version, and publish.
3. Every key signed by the old private key stops verifying against the new build. Re-issue a new key (with the new private key) to every affected buyer.
4. If the private key was compromised (not just lost), treat any keys it could have signed as untrustworthy going forward — this is why there is no expiry field to invalidate individually; a full key rotation is the only remedy.
