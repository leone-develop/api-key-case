import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultToolDeps, registerAllTools } from "./tools.js";

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")) as { version: string };
  return pkg.version;
}

// Does not connect a transport itself: the caller (packages/cli/index.ts's
// `mcp` command) owns that, so this stays reusable and testable without
// spawning a process (phase-4-mcp.md section 5.1).
export function createMcpServer(defaultProjectDir: string): McpServer {
  const server = new McpServer({ name: "api-key-case", version: packageVersion() });
  registerAllTools(server, defaultToolDeps(defaultProjectDir));
  return server;
}
