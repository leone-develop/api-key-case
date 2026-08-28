import { pathToFileURL } from "node:url";

// True when this module is the entry point. Guarded against `node -e`, where
// process.argv[1] is undefined.
export function isMain(moduleUrl) {
  return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(process.argv[1]).href;
}
