import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createFirstSampleAssets } from "./first-sample-assets.mjs";
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(packageDir, "../..");
const outputRoot = path.join(root, ".cache/agents/scratch/release-video");
fs.mkdirSync(outputRoot, { recursive: true });
const out = fs.mkdtempSync(path.join(outputRoot, "capture-"));
const ffmpeg = process.env.ROM_WEAVER_FFMPEG || "ffmpeg";
execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
execFileSync("bsdtar", ["--version"], { stdio: "ignore" });
console.log(`Recording evidence: ${out}`);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.ROM_WEAVER_SYSTEM_CHROME === "1" ? { channel: "chrome" } : {}),
  args: ["--mute-audio"],
});
try {
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    colorScheme: "dark",
  });
  await ctx.addInitScript(() =>
    localStorage.setItem(
      "rom-weaver-settings",
      JSON.stringify({
        version: 10,
        common: { onboardingEnabled: false, defaultCompression: "none" },
        apply: { output: { postApplyDownloadBehavior: "show" } },
      }),
    ),
  );
  const page = await ctx.newPage(),
    errors = [],
    frames = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(new URL("/apply-patches", process.env.ROM_WEAVER_VIDEO_BASE_URL || "https://localhost:4173/").href, {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const c = document.createElement("div");
    c.id = "capture-cursor";
    c.style.cssText =
      "position:fixed;left:0;top:0;transform:translate(850px,450px);width:22px;height:28px;pointer-events:none;z-index:2147483647;filter:drop-shadow(0 1px 2px #0008)";
    c.innerHTML =
      '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 23 L7 18 L11 26 L15 24 L11 16 L19 16 Z" fill="white" stroke="#181818" stroke-width="1.5"/></svg>';
    document.body.append(c);
  });
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", (e) => {
    frames.push({ time: e.metadata.timestamp, data: Buffer.from(e.data, "base64") });
    void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch((error) => errors.push(error.message));
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 1200, maxHeight: 900 });
  const pause = (ms) => page.waitForTimeout(ms);
  let from = { x: 850, y: 450 };
  async function move(l) {
    const b = await l.boundingBox();
    if (!b) throw Error("Capture target is not visible");
    const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await page.evaluate(
      ({ from, to }) =>
        new Promise((resolve) => {
          const start = performance.now();
          function tick(now) {
            const t = Math.min(1, (now - start) / 650),
              p = t * t * (3 - 2 * t);
            document.querySelector("#capture-cursor").style.transform =
              `translate(${from.x + (to.x - from.x) * p}px,${from.y + (to.y - from.y) * p}px)`;
            if (t < 1) requestAnimationFrame(tick);
            else resolve();
          }
          requestAnimationFrame(tick);
        }),
      { from, to },
    );
    from = to;
    await page.mouse.move(to.x, to.y);
  }
  await pause(1200);
  const add = page.getByText("Add files", { exact: true });
  await move(add);
  await pause(250);
  const cp = page.waitForEvent("filechooser");
  await add.click();
  await (await cp).setFiles(path.join(root, "packages/rom-weaver-webapp/dist/first-weave.zip"));
  await page.getByText("Hello to ROM", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("#rom-weaver-button-apply")?.disabled === false);
  await pause(1700);
  const checks = page.getByRole("button", { name: /^Checks/ }).first();
  await move(checks);
  await pause(200);
  await checks.click();
  await pause(600);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now(),
          from = scrollY;
        function tick(now) {
          const t = Math.min(1, (now - start) / 900),
            p = t * t * (3 - 2 * t);
          scrollTo(0, from + 370 * p);
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        }
        requestAnimationFrame(tick);
      }),
  );
  await pause(900);
  const format = page.locator("#rom-weaver-select-output-format");
  await move(format);
  await pause(300);
  const value = await format
    .locator("option")
    .evaluateAll((es) => es.find((e) => e.textContent.trim() === ".7z")?.value);
  if (value === undefined) throw Error("7z missing");
  await format.selectOption(value);
  await pause(900);
  const apply = page.locator("#rom-weaver-button-apply");
  await move(apply);
  await pause(300);
  await apply.click();
  const download = page.getByRole("button", { name: /^Download .*\.7z/ });
  await download.waitFor({ timeout: 60000 });
  await pause(3000);
  const end = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await page.screenshot({ path: path.join(out, "ready.png") });
  const dp = page.waitForEvent("download");
  await download.click();
  const d = await dp;
  await d.saveAs(path.join(out, "output.7z"));
  const extracted = execFileSync("bsdtar", ["-xOf", path.join(out, "output.7z")]);
  if (!extracted.equals(createFirstSampleAssets().wovenRom))
    throw Error("Downloaded archive does not match the woven sample ROM");
  if (errors.length) throw Error(errors.join("\n"));
  if (frames.length < 2) throw Error("Browser did not produce enough video frames");
  fs.mkdirSync(path.join(out, "frames"));
  let list = "";
  for (let i = 0; i < frames.length; i++) {
    const name = String(i).padStart(5, "0") + ".png";
    fs.writeFileSync(path.join(out, "frames", name), frames[i].data);
    list += `file 'frames/${name}'\noption framerate 1000\nduration ${Math.max(0.001, (frames[i + 1]?.time ?? end) - frames[i].time).toFixed(6)}\n`;
  }
  list += `file 'frames/${String(frames.length - 1).padStart(5, "0")}.png'\noption framerate 1000\n`;
  fs.writeFileSync(path.join(out, "frames.txt"), list);
  fs.writeFileSync(
    path.join(out, "recording.json"),
    JSON.stringify(
      { frames: frames.length, seconds: end - frames[0].time, filename: d.suggestedFilename(), errors },
      null,
      2,
    ),
  );
  console.log("Captured", frames.length, "frames");
  const video = path.join(out, "apply-workflow.mp4");
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      path.join(out, "frames.txt"),
      "-vf",
      "fps=30",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      video,
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-xerror", "-i", video, "-f", "null", "-"], {
    stdio: "inherit",
    timeout: 60_000,
  });
  const size = fs.statSync(video).size;
  if (size === 0 || size > 10_000_000) throw Error(`Unexpected video size: ${size} bytes`);
  fs.copyFileSync(video, path.join(outputRoot, "apply-workflow.mp4"));
  console.log(`Validated 30 fps MP4: ${size} bytes`);
} finally {
  await browser.close();
}
