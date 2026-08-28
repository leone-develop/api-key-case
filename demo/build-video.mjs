// Encodes the PNG sequence into demo.mp4 and grabs a poster frame.
//
// A silent AAC track is muxed in on purpose: several places this video gets
// posted (X, LinkedIn) mishandle video-only MP4s.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isMain } from "./lib/main.mjs";
import { VIDEO, demoBgmFromArgs, demoLocaleFromArgs, demoVariant, findFfmpeg } from "./config.mjs";

function run(ffmpeg, args) {
  const result = spawnSync(ffmpeg, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}):\n${result.stderr?.slice(-4000) ?? ""}`);
  }
  return result.stderr ?? "";
}

export function buildVideo({ keepFrames = false, locale = "en", bgmPath = null } = {}) {
  const variant = demoVariant(locale);
  const ffmpeg = findFfmpeg();
  if (!existsSync(variant.framesDir) || readdirSync(variant.framesDir).length === 0) {
    throw new Error(`no frames in ${variant.framesDir} — run render-frames.mjs --locale ${locale} first.`);
  }

  const frameCount = readdirSync(variant.framesDir).filter((name) => name.endsWith(".png")).length;
  const durationSeconds = frameCount / VIDEO.fps;
  const bgm = bgmPath ? resolve(bgmPath) : null;
  if (bgm && !existsSync(bgm)) {
    throw new Error(`BGM file does not exist: ${bgm}`);
  }
  console.log(`encoding ${frameCount} frames with ${ffmpeg}`);
  if (bgm) console.log(`audio:   ${basename(bgm)} at 18% volume with fade in/out`);

  const audioInput = bgm
    ? ["-stream_loop", "-1", "-i", bgm]
    : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
  const audioFilter = bgm
    ? [
        "-filter:a",
        `volume=0.18,afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, durationSeconds - 2.5).toFixed(3)}:d=2.5`
      ]
    : [];

  run(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-framerate", String(VIDEO.fps),
    "-i", join(variant.framesDir, "f%05d.png"),
    ...audioInput,
    "-map", "0:v:0",
    "-map", "1:a:0",
    ...audioFilter,
    "-shortest",
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.1",
    "-c:a", "aac",
    "-b:a", "96k",
    "-movflags", "+faststart",
    variant.videoPath
  ]);

  const posterFrame = join(variant.framesDir, `f${String(Math.min(frameCount - 1, Math.round(VIDEO.fps * 4.5))).padStart(5, "0")}.png`);
  run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", posterFrame, "-q:v", "3", variant.posterPath]);

  if (!keepFrames) {
    rmSync(variant.framesDir, { recursive: true, force: true });
    console.log("frames removed (pass --keep-frames to keep them)");
  }

  const size = statSync(variant.videoPath).size;
  console.log(`video:  ${variant.videoPath}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`poster: ${variant.posterPath}`);
  return { path: variant.videoPath, bytes: size, frameCount };
}

export function probe(locale = "en") {
  const variant = demoVariant(locale);
  const ffmpeg = findFfmpeg();
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (match) => match.replace(/ffmpeg/i, "ffprobe"));
  const result = spawnSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration,size:stream=codec_name,width,height,r_frame_rate", "-of", "default=noprint_wrappers=1", variant.videoPath],
    { encoding: "utf8", windowsHide: true }
  );
  return result.stdout ?? "";
}

if (isMain(import.meta.url)) {
  try {
    const locale = demoLocaleFromArgs();
    const bgmPath = demoBgmFromArgs();
    buildVideo({ keepFrames: process.argv.includes("--keep-frames"), locale, bgmPath });
    console.log(probe(locale));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
