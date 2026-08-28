// Renders a handful of timestamps to build/preview/*.png so the layout can be
// checked without waiting for a full frame render.
//
//   node preview.mjs 0 3000 12000 30000

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILD_DIR, VIDEO, demoLocaleFromArgs, demoVariant, findChrome } from "./config.mjs";
import { connect, findPageTarget, launchChrome } from "./lib/cdp.mjs";
import { writeScene } from "./render-frames.mjs";

const locale = demoLocaleFromArgs();
const variant = demoVariant(locale);
const PREVIEW_DIR = join(BUILD_DIR, locale === "en" ? "preview" : `preview-${locale}`);

const args = process.argv.slice(2);
const localeIndex = args.indexOf("--locale");
if (localeIndex !== -1) args.splice(localeIndex, 2);
const times = args.map(Number);

const timeline = writeScene(locale);
const chosen = times.length > 0 ? times : defaultTimes(timeline);

rmSync(PREVIEW_DIR, { recursive: true, force: true });
mkdirSync(PREVIEW_DIR, { recursive: true });

const chrome = await launchChrome(process.env.CHROME_PATH ?? findChrome(), VIDEO);
const client = await connect(await findPageTarget(chrome.port));
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

for (const t of chosen) {
  await client.send("Runtime.evaluate", { expression: `window.renderFrame(${t})`, returnByValue: true });
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  const file = join(PREVIEW_DIR, `t${String(t).padStart(6, "0")}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(file);
}

client.close();
chrome.close();
console.log(`timeline duration: ${(timeline.meta.durationMs / 1000).toFixed(1)}s`);

function defaultTimes(tl) {
  const marks = [1000, 4000, 6500];
  for (const note of tl.notes) marks.push(note.start + Math.min(3000, (note.end - note.start) / 2));
  const outro = tl.cards.find((card) => card.kind === "outro");
  if (outro) marks.push(outro.start + 3000);
  return marks.map((value) => Math.round(value));
}
