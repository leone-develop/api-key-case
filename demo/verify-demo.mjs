// Checks the build artifacts for anything that must never be published.
//
// build/scene.html embeds the entire timeline, and the timeline is the only
// source of text the renderer can draw. So a string absent from scene.html
// cannot appear in any frame of the video — which makes grepping it a
// meaningful check on the finished video, not just on the transcript.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename } from "node:path";
import { isMain } from "./lib/main.mjs";
import {
  CLI_ENTRY,
  DEMO_SECRET_VALUE,
  TRANSCRIPT_PATH,
  demoVariant
} from "./config.mjs";

// Same shapes packages/core/patterns.ts looks for. If one of these ever
// matches a build artifact, something printed a credential.
const CREDENTIAL_SHAPES = [
  { name: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI-style API key", regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "AWS access key id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Stripe live key", regex: /\b(?:sk|pk)_live_[A-Za-z0-9]{16,}\b/ },
  { name: "Resend API key", regex: /\bre_[A-Za-z0-9_]{16,}\b/ },
  { name: "Lemon Squeezy license key", regex: /\bls_[a-z0-9]{6,}\b/i },
  { name: "AKC license key", regex: /\bAKC1\.[A-Za-z0-9_-]{10,}/ }
];

export function verifyArtifacts({ locales = ["en"] } = {}) {
  const problems = [];
  const artifacts = [
    ["build/transcript.json", TRANSCRIPT_PATH],
    ...locales.flatMap((locale) => {
      const variant = demoVariant(locale);
      return [
        [`build/${locale}/scene.html`, variant.scenePath],
        [`build/${locale}/captions.srt`, variant.captionsPath],
        [`build/${locale}/captions.vtt`, variant.captionsVttPath]
      ];
    })
  ].filter(([, path]) => existsSync(path));

  if (artifacts.length === 0) {
    throw new Error("no build artifacts to verify");
  }

  const username = safeUsername();
  const homeLeaf = basename(homedir());

  for (const [label, path] of artifacts) {
    const contents = readFileSync(path, "utf8");

    if (contents.includes(DEMO_SECRET_VALUE)) {
      problems.push(`${label}: contains the demo secret value`);
    }
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.regex.test(contents)) {
        problems.push(`${label}: matches a ${shape.name} pattern`);
      }
    }
    for (const name of new Set([username, homeLeaf].filter(Boolean))) {
      if (contents.toLowerCase().includes(String(name).toLowerCase())) {
        problems.push(`${label}: contains the local account name`);
      }
    }
  }

  const entitlement = readEntitlementId();
  if (entitlement) {
    for (const [label, path] of artifacts) {
      if (readFileSync(path, "utf8").includes(entitlement)) {
        problems.push(`${label}: contains this machine's Pro license identifier`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`SECURITY: demo artifacts failed verification:\n  - ${problems.join("\n  - ")}`);
  }

  const checks = [
    "no secret value in any artifact",
    "no credential-shaped string in any artifact",
    "no local account name in any artifact",
    entitlement ? "no Pro license identifier in any artifact" : "no Pro license installed to leak"
  ];
  console.log(`verified ${artifacts.length} artifacts: ${checks.join("; ")}.`);

  for (const locale of locales) {
    const variant = demoVariant(locale);
    if (existsSync(variant.videoPath)) {
      console.log(`video present (${locale}): ${variant.videoPath}`);
    }
  }
  return { checks };
}

function safeUsername() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? null;
  }
}

// Read, compare, discard. The identifier is never printed or written anywhere.
function readEntitlementId() {
  if (!existsSync(CLI_ENTRY)) return null;
  const result = spawnSync(process.execPath, [CLI_ENTRY, "license", "status", "--json"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) return null;
  try {
    const status = JSON.parse(result.stdout);
    return status.plan === "pro" ? status.entitlementId : null;
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) {
  try {
    verifyArtifacts();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
