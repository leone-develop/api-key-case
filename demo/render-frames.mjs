// Renders the timeline to a PNG sequence with headless Chrome.
//
// The scene is a pure function of time: render-frames asks the page for the
// state at t = frame / fps and screenshots it. No wall-clock animation is
// involved, so the same transcript always produces the same frames.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BUILD_DIR,
  DEMO_DIR,
  TRANSCRIPT_PATH,
  VIDEO,
  demoLocaleFromArgs,
  demoVariant,
  findChrome
} from "./config.mjs";
import { connect, findPageTarget, launchChrome } from "./lib/cdp.mjs";
import { isMain } from "./lib/main.mjs";
import { buildTimeline, toSrt, toVtt } from "./storyboard.mjs";

export function writeScene(locale = "en") {
  const variant = demoVariant(locale);
  const timeline = buildTimeline(TRANSCRIPT_PATH, locale);
  const template = readFileSync(join(DEMO_DIR, "scene.html"), "utf8");
  const html = template.replace("/*__TIMELINE__*/ null", JSON.stringify(timeline));
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(variant.scenePath, html, "utf8");
  writeFileSync(variant.captionsPath, toSrt(timeline), "utf8");
  writeFileSync(variant.captionsVttPath, toVtt(timeline), "utf8");
  return timeline;
}

export async function renderFrames({ locale = "en" } = {}) {
  const variant = demoVariant(locale);
  const timeline = writeScene(locale);
  const totalFrames = Math.ceil((timeline.meta.durationMs / 1000) * VIDEO.fps);

  rmSync(variant.framesDir, { recursive: true, force: true });
  mkdirSync(variant.framesDir, { recursive: true });

  const chrome = await launchChrome(process.env.CHROME_PATH ?? findChrome(), VIDEO);
  let client;
  try {
    client = await connect(await findPageTarget(chrome.port));
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: VIDEO.width,
      height: VIDEO.height,
      deviceScaleFactor: 1,
      mobile: false
    });

    const loaded = client.once("Page.loadEventFired");
    await client.send("Page.navigate", { url: pathToFileURL(variant.scenePath).href });
    await loaded;

    const ready = await evaluate(client, "typeof window.renderFrame");
    if (ready !== "function") {
      throw new Error("scene.html did not expose renderFrame(); the timeline injection probably failed.");
    }

    console.log(`rendering ${totalFrames} frames (${(timeline.meta.durationMs / 1000).toFixed(1)}s @ ${VIDEO.fps}fps)`);

    let previousHash = null;
    let previousPng = null;
    let reused = 0;
    const startedAt = Date.now();

    for (let frame = 0; frame < totalFrames; frame += 1) {
      const t = Math.round((frame * 1000) / VIDEO.fps);
      const hash = await evaluate(client, `window.renderFrame(${t})`);

      let png;
      if (hash === previousHash && previousPng) {
        png = previousPng;
        reused += 1;
      } else {
        const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        png = Buffer.from(shot.data, "base64");
        previousPng = png;
        previousHash = hash;
      }

        writeFileSync(join(variant.framesDir, `f${String(frame).padStart(5, "0")}.png`), png);

      if (frame % 150 === 0 || frame === totalFrames - 1) {
        const pct = (((frame + 1) / totalFrames) * 100).toFixed(0);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        process.stdout.write(`  ${pct}%  frame ${frame + 1}/${totalFrames}  ${elapsed}s\n`);
      }
    }

    console.log(`frames written to ${variant.framesDir} (${reused} reused from an identical previous frame)`);
    return { totalFrames, timeline };
  } finally {
    if (client) client.close();
    chrome.close();
  }
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(`scene.html threw: ${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description ?? "")}`);
  }
  return result.result.value;
}

if (isMain(import.meta.url)) {
  try {
    const locale = demoLocaleFromArgs();
    renderFrames({ locale }).catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
