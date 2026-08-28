// Shared paths and knobs for the demo pipeline.
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = dirname(DEMO_DIR);
export const BUILD_DIR = join(DEMO_DIR, "build");
export const FRAMES_DIR = join(BUILD_DIR, "frames");
export const TRANSCRIPT_PATH = join(BUILD_DIR, "transcript.json");
export const SCENE_PATH = join(BUILD_DIR, "scene.html");
export const VIDEO_PATH = join(BUILD_DIR, "demo.mp4");
export const POSTER_PATH = join(BUILD_DIR, "demo-poster.jpg");
export const CAPTIONS_PATH = join(BUILD_DIR, "captions.srt");
export const CAPTIONS_VTT_PATH = join(BUILD_DIR, "captions.vtt");

// Keep the original English artifact names stable. The Japanese edition is
// generated alongside them so publishing or rebuilding one language never
// removes the other.
export const JAPANESE_FRAMES_DIR = join(BUILD_DIR, "frames-ja");
export const JAPANESE_SCENE_PATH = join(BUILD_DIR, "scene-ja.html");
export const JAPANESE_VIDEO_PATH = join(BUILD_DIR, "demo-ja.mp4");
export const JAPANESE_POSTER_PATH = join(BUILD_DIR, "demo-ja-poster.jpg");
export const JAPANESE_CAPTIONS_PATH = join(BUILD_DIR, "captions-ja.srt");
export const JAPANESE_CAPTIONS_VTT_PATH = join(BUILD_DIR, "captions-ja.vtt");

export const DEMO_VARIANTS = Object.freeze({
  en: Object.freeze({
    locale: "en",
    framesDir: FRAMES_DIR,
    scenePath: SCENE_PATH,
    videoPath: VIDEO_PATH,
    posterPath: POSTER_PATH,
    captionsPath: CAPTIONS_PATH,
    captionsVttPath: CAPTIONS_VTT_PATH
  }),
  ja: Object.freeze({
    locale: "ja",
    framesDir: JAPANESE_FRAMES_DIR,
    scenePath: JAPANESE_SCENE_PATH,
    videoPath: JAPANESE_VIDEO_PATH,
    posterPath: JAPANESE_POSTER_PATH,
    captionsPath: JAPANESE_CAPTIONS_PATH,
    captionsVttPath: JAPANESE_CAPTIONS_VTT_PATH
  })
});

export function demoVariant(locale = "en") {
  const variant = DEMO_VARIANTS[locale];
  if (!variant) {
    throw new Error(`unsupported demo locale: ${locale} (expected en or ja)`);
  }
  return variant;
}

export function demoLocaleFromArgs(args = process.argv.slice(2)) {
  const index = args.indexOf("--locale");
  if (index === -1) return "en";
  if (!args[index + 1]) throw new Error("--locale requires en or ja");
  return demoVariant(args[index + 1]).locale;
}

export function demoBgmFromArgs(args = process.argv.slice(2)) {
  const index = args.indexOf("--bgm");
  if (index === -1) return null;
  if (!args[index + 1]) throw new Error("--bgm requires a path to an audio file");
  return args[index + 1];
}

// The throwaway project the demo scans. Deliberately outside the repository so
// a scan can never walk into real source, and so nothing here is git-tracked.
// The CLI prints the absolute path it scanned, and that path ends up on screen,
// so the sandbox is kept out of the user profile: no account name in the video.
export const SANDBOX_ROOT =
  process.env.DEMO_SANDBOX_ROOT ??
  (process.platform === "win32" ? "C:\\Users\\Public\\api-key-case-demo" : join(tmpdir(), "api-key-case-demo"));
export const SANDBOX_DIR = join(SANDBOX_ROOT, "demo-checkout");

// The demo secret. Fabricated, stored only under the sandbox project's scope,
// and deleted by cleanup-demo.mjs. It is typed into a hidden prompt, so it
// never reaches argv, the transcript, or a video frame.
export const DEMO_SECRET_NAME = "OPENAI_API_KEY";
export const DEMO_SECRET_VALUE = "demo-only-value-not-a-real-key";

export const CLI_ENTRY = join(REPO_DIR, "dist", "cli", "index.js");

export const VIDEO = {
  width: 1920,
  height: 1080,
  fps: 30
};

// The ConPTY is sized to the terminal panel in the scene so that any wrapping
// the CLI does on capture is the same wrapping the video shows.
export const PTY = { cols: 96, rows: 60 };

export function findFfmpeg() {
  return findExecutable("ffmpeg", [
    join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages")
  ]);
}

export function findChrome() {
  const candidates = [
    join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find Chrome or Edge. Set CHROME_PATH to a Chromium executable.");
}

function findExecutable(name, extraRoots) {
  if (process.env[`${name.toUpperCase()}_PATH`]) {
    return process.env[`${name.toUpperCase()}_PATH`];
  }

  const exeName = process.platform === "win32" ? `${name}.exe` : name;
  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = join(dir, exeName);
    if (existsSync(candidate)) return candidate;
  }

  // winget installs land in a versioned directory that is only added to PATH
  // for new shells, so look there before giving up.
  for (const root of extraRoots) {
    const found = searchForFile(root, exeName, 5);
    if (found) return found;
  }

  throw new Error(
    `Could not find ${name}. Install it (Windows: winget install Gyan.FFmpeg) ` +
      `or set ${name.toUpperCase()}_PATH.`
  );
}

function searchForFile(root, fileName, depth) {
  if (!root || depth < 0 || !existsSync(root)) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return join(root, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = searchForFile(join(root, entry.name), fileName, depth - 1);
      if (found) return found;
    }
  }
  return null;
}
