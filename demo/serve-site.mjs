// Local-only preview server for the landing and policy pages.
// It serves the repository root so links match the production Pages layout.

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("../", import.meta.url));
const port = Number.parseInt(process.argv[2] ?? "4173", 10);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".mp4", "video/mp4"],
  [".vtt", "text/vtt; charset=utf-8"]
]);

createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = normalize(relative);

  if (normalized.startsWith("..") || normalized.includes(":") || normalized.startsWith(".env")) {
    response.writeHead(404).end("Not found");
    return;
  }

  const mapped = /^(?:demo|demo-ja)(?:-poster)?\.(?:mp4|vtt|jpg)$/.test(normalized)
    ? join(repoDir, "demo", "build", normalized)
    : join(repoDir, normalized);

  try {
    if (!statSync(mapped).isFile()) throw new Error("not a file");
  } catch {
    response.writeHead(404).end("Not found");
    return;
  }

  response.setHeader("Content-Type", contentTypes.get(extname(mapped)) ?? "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  createReadStream(mapped).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`API Key Case site preview: http://127.0.0.1:${port}/`);
});
