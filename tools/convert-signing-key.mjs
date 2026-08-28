#!/usr/bin/env node
// Maintainer-only tool (companion to issue-license.mjs; excluded from the
// npm package the same way). Converts the Ed25519 PKCS#8 PEM signing key to
// the single-line base64 DER form that `api-key-case save` can hold, so the
// live Worker's AKC_ED25519_PRIVATE_KEY can be placed through the product
// itself (save -> deploy). The Worker accepts both forms.
//
// The converted value is written to STDOUT ONLY, and only when stdout is a
// pipe — never to a terminal, a log, or a file. Intended use:
//   node tools/convert-signing-key.mjs <path-to-private-key.pem> | clip
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { isInsideRepo, issueLicenseKey } from "./issue-license.mjs";

function fail(message) {
  console.error(message);
  process.exit(2);
}

const [pemPath, ...rest] = process.argv.slice(2);
if (!pemPath || rest.length > 0) {
  fail("usage: node tools/convert-signing-key.mjs <path-to-private-key.pem> | clip");
}
if (process.stdout.isTTY) {
  fail("refusing to print the key to a terminal; pipe stdout, e.g. `... | clip`");
}
if (isInsideRepo(pemPath)) {
  fail("refusing to read a private key from inside the repo working tree");
}

let pem;
try {
  pem = readFileSync(pemPath, "utf8");
} catch (err) {
  fail(`cannot read ${pemPath}: ${err.code ?? err.message}`);
}
if (pem.includes("ENCRYPTED PRIVATE KEY")) {
  fail("encrypted PKCS#8 is not supported; export an unencrypted PKCS#8 PEM");
}
const match = pem.match(/-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----/);
if (!match) {
  fail("no PKCS#8 'BEGIN PRIVATE KEY' block found in the file");
}
const base64Der = match[1].replace(/\s+/g, "");

let keyObject;
try {
  keyObject = createPrivateKey({ key: Buffer.from(base64Der, "base64"), format: "der", type: "pkcs8" });
} catch {
  fail("the PEM body does not decode to a valid PKCS#8 private key");
}
if (keyObject.asymmetricKeyType !== "ed25519") {
  fail(`expected an ed25519 key, got ${keyObject.asymmetricKeyType}`);
}

// Guard against configuring the wrong key: a signature made with this key
// must verify against the public key embedded in the shipped CLI.
let parseLicenseKey;
try {
  ({ parseLicenseKey } = await import("../dist/core/license.js"));
} catch {
  fail("dist/core/license.js not found; run `npm run build` first (needed to verify the key matches the embedded public key)");
}
const probe = issueLicenseKey(pem, "convert-signing-key-probe");
if (parseLicenseKey(probe).plan !== "pro") {
  fail("this private key does NOT match EMBEDDED_PUBLIC_KEY_PEM in packages/core/license.ts — wrong key file?");
}

process.stdout.write(`${base64Der}\n`);
console.error("ok: single-line base64 PKCS#8 DER written to stdout (verified against the embedded public key)");
