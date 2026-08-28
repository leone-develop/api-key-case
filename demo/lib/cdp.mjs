// A minimal Chrome DevTools Protocol client.
//
// Node 22+ ships a global WebSocket, so driving Chrome needs no dependency at
// all: launch it headless, read the port it wrote to its profile directory,
// and speak CDP over one socket.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function launchChrome(chromePath, { width, height }) {
  const userDataDir = mkdtempSync(join(tmpdir(), "akc-demo-chrome-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--no-sandbox",
    "--force-device-scale-factor=1",
    "--font-render-hinting=none",
    "--disable-lcd-text",
    `--window-size=${width},${height}`,
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "about:blank"
  ];

  const proc = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const portFile = join(userDataDir, "DevToolsActivePort");
  let port = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (proc.exitCode !== null) {
      throw new Error(`Chrome exited with code ${proc.exitCode}:\n${stderr}`);
    }
    if (existsSync(portFile)) {
      const contents = readFileSync(portFile, "utf8").split("\n");
      if (contents[0] && contents[0].trim()) {
        port = Number.parseInt(contents[0].trim(), 10);
        break;
      }
    }
    await delay(100);
  }
  if (!port) {
    proc.kill();
    throw new Error(`Chrome did not report a debugging port.\n${stderr}`);
  }

  return {
    port,
    close() {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      // Chrome holds the profile briefly after exit; a failed cleanup is not
      // worth failing the build over.
      setTimeout(() => {
        try {
          rmSync(userDataDir, { recursive: true, force: true });
        } catch {
          /* leave it for the OS */
        }
      }, 500);
    }
  };
}

export async function findPageTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* Chrome is still starting */
    }
    await delay(100);
  }
  throw new Error("Could not find a Chrome page target to attach to.");
}

export async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    if (message.method && listeners.has(message.method)) {
      for (const handler of listeners.get(message.method)) handler(message.params);
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(handler);
    },
    once(method) {
      return new Promise((resolve) => {
        const handler = (params) => {
          const handlers = listeners.get(method) ?? [];
          listeners.set(
            method,
            handlers.filter((item) => item !== handler)
          );
          resolve(params);
        };
        this.on(method, handler);
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  };
}
