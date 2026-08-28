#!/usr/bin/env node
// Windows counterpart of pty-drive.py, driving a ConPTY instead of a POSIX pty.
//
// Same reason for existing: packages/cli/prompt.ts refuses to read a secret
// value or a production confirmation from anything that is not a TTY, and
// AGENTS.md section 3 forbids adding a bypass ("there is no flag to skip
// this"). So the end-to-end job types into a real console the way a human
// does, rather than weakening the product to make it testable.
//
// ConPTY (Windows 10 1809+) is what gives the child a genuine console handle,
// so `process.stdin.isTTY` is true inside it and the hidden-input path runs
// exactly as it does for a user. node-pty is installed by the e2e workflow
// only -- it is never a dependency of the published package.
//
// Same command-line contract as pty-drive.py, so tests/e2e/deploy-e2e.sh can
// swap one for the other by platform.
//
// Usage:
//   node pty-drive.mjs --step 'PROMPT=>env:VARNAME' \
//                      --step 'PROMPT=>literal:yes' \
//                      [--mask-env VARNAME] [--transcript FILE] \
//                      [--raw-transcript FILE] [--timeout SECONDS] \
//                      -- command arg...
//
// Exit status: the child's, or 97 (a prompt never appeared) / 98 (timeout).

import { existsSync, openSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

// A human takes a moment to reach for the keyboard; this harness does not.
// prompt.ts writes the prompt and only then switches the console to raw mode
// (echo off), so answering instantly can land our own keystrokes in the
// transcript as console echo -- indistinguishable, to the leak check, from
// the product having printed the value. Pausing bridges that window. The
// POSIX driver solves the same problem by clearing ECHO on the pty, which
// ConPTY does not expose.
const ANSWER_DELAY_MS = 250;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

function parseStep(raw) {
  const marker = raw.indexOf("=>");
  if (marker === -1) {
    throw new Error(`--step needs PROMPT=>SOURCE:VALUE, got ${JSON.stringify(raw)}`);
  }
  const prompt = raw.slice(0, marker);
  const source = raw.slice(marker + 2);
  if (!prompt) {
    throw new Error("--step prompt must not be empty");
  }

  if (source.startsWith("env:")) {
    const name = source.slice(4);
    const value = process.env[name];
    if (!value) {
      throw new Error(`--step referenced env ${name}, which is unset or empty`);
    }
    return { prompt, value, secret: true };
  }
  if (source.startsWith("literal:")) {
    // Literal answers ("yes") are deliberately not masked: they are not
    // secrets, and masking such common words would corrupt the transcript
    // the caller asserts on.
    return { prompt, value: source.slice(8), secret: false };
  }
  throw new Error(`--step source must be env: or literal:, got ${JSON.stringify(source)}`);
}

function parseArgs(argv) {
  const opts = {
    steps: [],
    maskEnv: [],
    transcript: null,
    rawTranscript: null,
    timeout: 240,
    command: []
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--step") opts.steps.push(parseStep(argv[++i]));
    else if (arg === "--mask-env") opts.maskEnv.push(argv[++i]);
    else if (arg === "--transcript") opts.transcript = argv[++i];
    else if (arg === "--raw-transcript") opts.rawTranscript = argv[++i];
    else if (arg === "--timeout") opts.timeout = Number(argv[++i]);
    else if (arg === "--") {
      opts.command = argv.slice(i + 1);
      break;
    } else {
      opts.command = argv.slice(i);
      break;
    }
  }
  if (opts.command.length === 0) throw new Error("no command given (put it after --)");
  return opts;
}

// ConPTY repaints the screen: cursor moves, clears and colour runs are mixed
// into the byte stream. Strip them so the caller's greps see plain text.
// This removes escape sequences only -- it can never remove a secret value,
// so the leak check (which reads the raw transcript) stays honest.
const OSC = new RegExp(`${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`, "g");
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const OTHER_ESCAPE = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");

function stripAnsi(text) {
  return text
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(OTHER_ESCAPE, "")
    .replace(/\r(?!\n)/g, ""); // bare CR from repaints; CRLF stays a line break
}

function mask(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***MASKED***");
  }
  return out;
}

function writePrivate(path, contents) {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

const opts = parseArgs(process.argv.slice(2));

let pty;
try {
  pty = await import("node-pty");
} catch {
  process.stderr.write(
    "pty-drive: node-pty is not installed. The Windows e2e job installs it with\n" +
      "  npm install --no-save node-pty\n" +
      "It is intentionally not a dependency of the published package.\n"
  );
  process.exit(2);
}

const secrets = [
  ...opts.maskEnv.map((name) => process.env[name] ?? ""),
  ...opts.steps.filter((step) => step.secret).map((step) => step.value)
];

// node-pty's Windows agent needs a real path -- it does no PATH lookup of its
// own and fails with "File not found" on a bare command name. This resolves
// the harness's own launcher (always `node`), and has nothing to do with the
// product's deliberately PATH-only vendor-CLI resolution in
// packages/core/deploy/which.ts.
function resolveCommand(command) {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;
  if (command === "node" || command === "node.exe") return process.execPath;

  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`could not resolve ${command} from PATH`);
}

const [command, ...args] = opts.command;
const child = pty.spawn(resolveCommand(command), args, {
  name: "xterm-256color",
  // Wide enough that ConPTY does not hard-wrap a line mid-value, which would
  // split a leaked secret across a newline and hide it from a plain grep.
  cols: 400,
  rows: 60,
  cwd: process.cwd(),
  env: process.env,
  useConpty: true
});

let transcript = "";
// Only text seen since the last answer is matched, so one prompt cannot be
// satisfied twice by text still sitting in the buffer.
let pending = "";
const steps = [...opts.steps];
let answering = false;
let settled = false;

function finish(code, reason) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);

  // Collapse the runs of blank lines ConPTY's repaints leave behind once the
  // cursor-movement escapes are gone. Display copy only -- the raw transcript
  // the leak check reads is never touched.
  const masked = mask(stripAnsi(transcript), secrets).replace(/\n{3,}/g, "\n\n");

  if (opts.transcript) writeFileSync(opts.transcript, masked, "utf8");
  // Unmasked copy for the caller's leak assertion. Grepping the masked
  // transcript would be circular: the mask would hide the very leak the
  // check exists to find. Never printed; deleted by the caller.
  if (opts.rawTranscript) writePrivate(opts.rawTranscript, transcript);

  process.stdout.write(masked.endsWith("\n") ? masked : `${masked}\n`);

  if (reason === "timeout") {
    process.stderr.write(`pty-drive: timed out after ${opts.timeout}s\n`);
    process.exit(98);
  }
  if (steps.length > 0) {
    const missing = steps.map((step) => step.prompt).join(", ");
    process.stderr.write(`pty-drive: child exited before these prompts appeared: ${missing}\n`);
    process.exit(97);
  }
  // node-pty keeps the event loop alive on its own, so exit explicitly.
  process.exit(code ?? 1);
}

const timer = setTimeout(() => {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  finish(null, "timeout");
}, opts.timeout * 1000);

child.onData((chunk) => {
  transcript += chunk;
  pending += chunk;

  if (answering || steps.length === 0) return;
  if (!stripAnsi(pending).includes(steps[0].prompt)) return;

  answering = true;
  const { value } = steps.shift();
  setTimeout(() => {
    child.write(`${value}\r`);
    pending = "";
    answering = false;
  }, ANSWER_DELAY_MS);
});

child.onExit(({ exitCode }) => {
  // Let any final bytes written just before exit arrive before settling.
  setTimeout(() => finish(exitCode, "exit"), 300);
});
