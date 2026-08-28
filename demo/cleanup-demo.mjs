// Removes everything the demo created outside build/: the sandbox project and
// the demo secret in the OS secret store.
//
// The secret is deleted through the product's own `remove` command, so this
// script never touches the store directly.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isMain } from "./lib/main.mjs";
import { CLI_ENTRY, DEMO_SECRET_NAME, SANDBOX_DIR, SANDBOX_ROOT } from "./config.mjs";

export function cleanup() {
  let removedSecret = false;

  if (existsSync(CLI_ENTRY)) {
    // Project scope is derived from the cwd's real path, so the directory has
    // to exist for `remove` to resolve the same scope `save` used. Recreating
    // it means a deleted sandbox cannot orphan the demo secret in the store.
    mkdirSync(SANDBOX_DIR, { recursive: true });
    const result = spawnSync(process.execPath, [CLI_ENTRY, "remove", DEMO_SECRET_NAME, "--yes"], {
      cwd: SANDBOX_DIR,
      encoding: "utf8",
      windowsHide: true
    });
    removedSecret = result.status === 0;
    console.log(
      removedSecret
        ? `removed ${DEMO_SECRET_NAME} from the OS secret store (project scope)`
        : `${DEMO_SECRET_NAME} was not registered in the sandbox scope; nothing to remove`
    );
  }

  if (existsSync(SANDBOX_ROOT)) {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
    console.log(`removed sandbox: ${SANDBOX_ROOT}`);
  }

  return { removedSecret };
}

if (isMain(import.meta.url)) {
  cleanup();
}
