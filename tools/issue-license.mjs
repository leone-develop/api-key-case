#!/usr/bin/env node
// Issuer-only tool (phase-5-license.md §6). Not part of the published npm
// package (see package.json "files") and not part of the TypeScript build:
// this stays a plain .mjs script run directly by the maintainer, the same
// way tests/run-tests.mjs is run directly.
//
// The private signing key never lives in this repository. This script only
// ever reads it from a path the caller supplies, and refuses to read (or
// write, for --keygen) anywhere inside the repo working tree.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEY_PREFIX = "AKC1";

export function generateKeypairPem() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

export function issueLicenseKey(privateKeyPem, entitlementId, issuedAt) {
  if (!entitlementId || typeof entitlementId !== "string") {
    throw new Error("entitlement id is required");
  }
  const payload = {
    v: 1,
    plan: "pro",
    id: entitlementId,
    issuedAt: issuedAt ?? new Date().toISOString().slice(0, 10)
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signedData = Buffer.from(`${KEY_PREFIX}.${payloadPart}`, "utf8");
  const signature = signEd25519(null, signedData, privateKeyPem);
  return `${KEY_PREFIX}.${payloadPart}.${signature.toString("base64url")}`;
}

function repoRoot() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
}

// Guards both --keygen's output dir and --key's input path (phase-5-license.md §6):
// neither the private key nor its containing directory may end up inside
// the repo working tree, where it could be committed by accident.
export function isInsideRepo(targetPath) {
  const root = resolve(repoRoot());
  const abs = resolve(targetPath);
  if (abs === root) return true;
  const rel = relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function parseArgs(argv) {
  const args = { keygenOut: null, key: null, entitlement: null, issuedAt: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keygen") {
      args.keygenOut = argv[++i] ?? null;
    } else if (arg === "--key") {
      args.key = argv[++i] ?? null;
    } else if (arg === "--entitlement") {
      args.entitlement = argv[++i] ?? null;
    } else if (arg === "--issued-at") {
      args.issuedAt = argv[++i] ?? null;
    }
  }
  return args;
}

function printUsageAndExit(code) {
  console.error(
    "Usage:\n" +
      "  node tools/issue-license.mjs --keygen <output-dir>\n" +
      "  node tools/issue-license.mjs --key <private-key-path> --entitlement <entitlement-id> [--issued-at YYYY-MM-DD]\n"
  );
  process.exit(code);
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.keygenOut) {
    if (isInsideRepo(args.keygenOut)) {
      console.error("Refusing to write a signing key inside the repository.");
      process.exit(1);
    }
    mkdirSync(args.keygenOut, { recursive: true });
    const { publicKeyPem, privateKeyPem } = generateKeypairPem();
    const privatePath = join(args.keygenOut, "license-private.pem");
    if (existsSync(privatePath)) {
      console.error(`Refusing to overwrite existing ${privatePath}.`);
      process.exit(1);
    }
    writeFileSync(privatePath, privateKeyPem, { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(args.keygenOut, "license-public.pem"), publicKeyPem, "utf8");
    console.log(`Keypair written to ${args.keygenOut}.`);
    console.log("Store license-private.pem somewhere safe (a password manager) and never commit it.");
    console.log("Paste license-public.pem's contents into EMBEDDED_PUBLIC_KEY_PEM in packages/core/license.ts.");
    return;
  }

  if (args.key && args.entitlement) {
    if (isInsideRepo(args.key)) {
      console.error("Refusing to read a signing key from inside the repository.");
      process.exit(1);
    }
    const privateKeyPem = readFileSync(resolve(args.key), "utf8");
    console.log(issueLicenseKey(privateKeyPem, args.entitlement, args.issuedAt ?? undefined));
    return;
  }

  printUsageAndExit(1);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
