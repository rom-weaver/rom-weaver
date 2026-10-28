import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { packHomebrewPbp } from "../fixtures/psn00bsdk-pbp.mjs";

const required = (name) => {
  assert(process.env[name], `${name} must identify the documented legal fixtures and fresh application build`);
  return process.env[name];
};

// This opt-in test MUST fail without explicit legal inputs; synthetic disc bytes cannot prove boot.
test("legal PBP programs render through the application and native disk control", { timeout: 300000 }, async (t) => {
  const base = new URL(required("ROM_WEAVER_PBP_BOOT_URL"));
  const fixtureDir = required("ROM_WEAVER_PBP_BOOT_FIXTURES");
  const artifacts = required("ROM_WEAVER_PBP_BOOT_ARTIFACTS");
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--mute-audio", "--enable-unsafe-swiftshader"] });
  const report = { browser: browser.version(), base: base.href, viewport: { width: 1280, height: 900 }, cases: [] };
  try {
    for (const [name, core, disks] of [
      ["ps1-pads-single.pbp", "psx", 1],
      ["psp-v1.0-C.pbp", "psp", 0],
      ["ps1-pads-multi.pbp", "psx", 2],
    ]) {
      await t.test(name, { timeout: 95000 }, async () => {
        const bytes = await readFile(path.join(fixtureDir, name));
        if (core === "psx") {
          const image = await readFile(path.join(fixtureDir, "pads.bin"));
          assert.deepEqual(bytes, packHomebrewPbp(disks === 2 ? [image, image] : [image]));
        }
        const context = await browser.newContext({
          viewport: report.viewport,
          ignoreHTTPSErrors: true,
          serviceWorkers: "block",
        });
        const external = [];
        const errors = [];
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== base.origin) {
            external.push(url.href);
            return route.abort();
          }
          return route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(new URL("test-rom", base).href, { waitUntil: "domcontentloaded" });
          await page
            .locator("#emulator-test-file-input")
            .setInputFiles({ name, mimeType: "application/octet-stream", buffer: bytes });
          const iframe = page.locator("iframe[title^='EmulatorJS test for']");
          await iframe.waitFor({ state: "attached", timeout: 60000 });
          const frame = await (await iframe.elementHandle()).contentFrame();
          assert(frame);
          await frame.waitForFunction(() => window.EJS_emulator?.started, null, { timeout: 60000 });
          assert.equal(await frame.evaluate(() => window.EJS_core), core);
          const canvas = frame.locator("canvas").first();
          const capture = async (suffix) => {
            const png = await canvas.screenshot();
            await writeFile(path.join(artifacts, `${name}.${suffix}.png`), png);
            return frame.evaluate(async (base64) => {
              const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
              const surface = document.createElement("canvas");
              surface.width = image.width;
              surface.height = image.height;
              const ctx = surface.getContext("2d");
              ctx.drawImage(image, 0, 0);
              const pixels = ctx.getImageData(0, 0, surface.width, surface.height).data;
              let brown = 0;
              let saturated = 0;
              let purple = 0;
              let padHash = 2166136261;
              let padWhite = 0;
              for (let index = 0; index < pixels.length; index += 4) {
                const [r, g, b] = pixels.subarray(index, index + 3);
                const y = Math.floor(index / 4 / image.width);
                if (y > image.height * 0.17 && y < image.height * 0.27) {
                  padHash = Math.imul(padHash ^ r ^ (g << 8) ^ (b << 16), 16777619);
                  if (r > 220 && g > 220 && b > 220) padWhite += 1;
                }
                if (r > 5 && r < 40 && g < 15 && b > 20 && b < 70) purple += 1;
                if (r > 35 && r < 65 && g > 12 && g < 40 && b < 15) brown += 1;
                if (Math.max(r, g, b) > 220 && Math.min(r, g, b) < 25) saturated += 1;
              }
              return { brown, saturated, purple, padHash, padWhite, width: image.width, height: image.height };
            }, png.toString("base64"));
          };
          let pixels;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            pixels = await capture("rendered");
            if (core === "psx" ? pixels.brown > 1000 && pixels.padWhite > 20 : pixels.saturated > 1000) break;
            await frame.evaluate(() => new Promise(requestAnimationFrame));
          }
          assert(
            core === "psx" ? pixels.brown > 1000 && pixels.padWhite > 20 : pixels.saturated > 1000,
            `expected demo pixels, got ${JSON.stringify(pixels)}`,
          );
          const native = await frame.evaluate(() => ({
            count: window.EJS_emulator.gameManager.getDiskCount(),
            index: window.EJS_emulator.gameManager.getCurrentDisk(),
          }));
          if (core === "psx") assert.deepEqual(native, { count: disks, index: 0 });
          await canvas.click();
          const key = core === "psp" ? "Enter" : "ArrowUp";
          await page.keyboard.down(key);
          for (let index = 0; index < 12; index += 1) await frame.evaluate(() => new Promise(requestAnimationFrame));
          const held = await capture("input-held");
          await page.keyboard.up(key);
          if (core === "psx") assert.notEqual(held.padHash, pixels.padHash, "controller byte region must respond");
          else assert(held.purple > 1000, "Start must switch the cube to the raycast scene");
          if (disks === 2) {
            await frame.locator("#ejs_disksMenu > button").click();
            await frame.getByRole("button", { name: "Disk 2", exact: true }).click();
            assert.equal(await frame.evaluate(() => window.EJS_emulator.gameManager.getCurrentDisk()), 1);
            for (let index = 0; index < 30; index += 1) await frame.evaluate(() => new Promise(requestAnimationFrame));
            const afterSwitch = await capture("disk-2");
            assert(afterSwitch.brown > 1000);
            const firstDisk = frame.getByRole("button", { name: "Disk 1", exact: true });
            if (!(await firstDisk.isVisible())) await frame.locator("#ejs_disksMenu > button").click();
            await firstDisk.click();
            assert.equal(await frame.evaluate(() => window.EJS_emulator.gameManager.getCurrentDisk()), 0);
            for (let index = 0; index < 30; index += 1) await frame.evaluate(() => new Promise(requestAnimationFrame));
            assert((await capture("disk-1-return")).brown > 1000);
          }
          assert.deepEqual(external, [], "pinned assets must not fall back to a remote CDN");
          assert.deepEqual(errors, []);
          report.cases.push({
            name,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            core,
            native,
            pixels,
            held,
          });
        } catch (error) {
          await writeFile(
            path.join(artifacts, `${name}.failure.txt`),
            `${error.stack}\n${await page.locator("body").innerText()}\nPage errors: ${JSON.stringify(errors)}\nExternal: ${JSON.stringify(external)}`,
          );
          await page.screenshot({ path: path.join(artifacts, `${name}.failure.png`) });
          throw error;
        } finally {
          await context.close();
        }
      });
    }
  } finally {
    await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
    await browser.close();
  }
});
