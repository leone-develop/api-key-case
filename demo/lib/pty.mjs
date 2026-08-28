// Runs a command inside a real Windows ConPTY (or a Unix pty) so the CLI sees
// an interactive terminal, exactly as it would for a human.
//
// This exists because api-key-case deliberately refuses non-interactive secret
// input: `save` exits with "secret input requires an interactive terminal" when
// stdin is a pipe, and the production deploy confirmation is TTY-only. Faking a
// TTY is not an option, so the demo allocates a genuine one.

import { createRequire } from "node:module";
import { renderScreen } from "./screen.mjs";

const require = createRequire(import.meta.url);

let ptyModule;
export function loadPty() {
  if (ptyModule) return ptyModule;
  try {
    ptyModule = require("@homebridge/node-pty-prebuilt-multiarch");
  } catch (err) {
    throw new Error(
      "node-pty is required to drive the real interactive CLI.\n" +
        "Run: cd demo && npm install\n" +
        `(underlying error: ${err.message})`
    );
  }
  return ptyModule;
}

/**
 * @param {object} opts
 * @param {string} opts.file            executable to run
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {Record<string,string>} [opts.env]
 * @param {number} [opts.cols]
 * @param {number} [opts.rows]
 * @param {number} [opts.timeoutMs]
 * @param {{waitFor: string, send: string, label?: string}[]} [opts.steps]
 *        Scripted keystrokes: when `waitFor` appears in the output, `send` is
 *        typed. `label` records what a human would have typed, for the
 *        transcript (used for values that must never be recorded verbatim).
 */
export function runInPty(opts) {
  const pty = loadPty();
  const steps = [...(opts.steps ?? [])];
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    let child;

    try {
      child = pty.spawn(opts.file, opts.args, {
        name: "xterm-256color",
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 40,
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) }
      });
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(new Error(`pty command timed out after ${timeoutMs}ms: ${opts.file} ${opts.args.join(" ")}`));
    }, timeoutMs);

    const pump = () => {
      while (steps.length > 0 && raw.includes(steps[0].waitFor)) {
        const step = steps.shift();
        // Small settle delay so the child has finished switching stdin into
        // raw mode before the keystrokes land.
        setTimeout(() => {
          try {
            child.write(step.send);
          } catch {
            /* child exited first */
          }
        }, 120);
      }
    };

    child.onData((chunk) => {
      raw += chunk;
      pump();
    });

    child.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lines = renderScreen(raw, opts.cols ?? 100, opts.rows ?? 40);
      resolve({ exitCode, lines, raw });
    });
  });
}
