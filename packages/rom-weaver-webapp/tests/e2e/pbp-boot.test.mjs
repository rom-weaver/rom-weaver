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
test("legal PBP programs render through the application and native disk control", { timeout: 600000 }, async (t) => {
  const base = new URL(required("ROM_WEAVER_PBP_BOOT_URL"));
  const expectedWasmHash = required("ROM_WEAVER_PBP_BOOT_WASM_SHA256");
  const revision = required("ROM_WEAVER_PBP_BOOT_REVISION");
  const fixtureDir = required("ROM_WEAVER_PBP_BOOT_FIXTURES");
  const artifacts = required("ROM_WEAVER_PBP_BOOT_ARTIFACTS");
  await mkdir(artifacts, { recursive: true });
  const lockBytes = await readFile(new URL("../../vendor/emulatorjs.lock.json", import.meta.url));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const assetPaths = ["loader.js", "cores/pcsx_rearmed-thread-wasm.data", "cores/ppsspp-thread-wasm.data"];
  const expectedAssets = Object.fromEntries(assetPaths.map((asset) => [asset, lock.files[asset]]));
  for (const hash of Object.values(expectedAssets)) assert.match(hash, /^[a-f0-9]{64}$/);
  const browser = await chromium.launch({ headless: true, args: ["--mute-audio", "--enable-unsafe-swiftshader"] });
  const report = {
    revision,
    expectedWasmHash,
    emulatorjs: {
      version: lock.version,
      lockSha256: createHash("sha256").update(lockBytes).digest("hex"),
      expectedAssets,
    },
    browser: browser.version(),
    base: base.href,
    viewport: { width: 1280, height: 900 },
    cases: [],
  };
  try {
    for (const [name, core, disks, stored = false] of [
      ["ps1-pads-single.pbp", "psx", 1],
      ["psp-v1.0-C.pbp", "psp", 0],
      ["ps1-pads-multi.pbp", "psx", 2],
      ["ps1-pads-single-stored.pbp", "psx", 1, true],
      ["ps1-pads-multi-stored.pbp", "psx", 2, true],
    ]) {
      await t.test(name, { timeout: 95000 }, async () => {
        const bytes = await readFile(path.join(fixtureDir, name));
        let expectedImage;
        if (core === "psx") {
          const data = await readFile(path.join(fixtureDir, "pads.bin"));
          expectedImage = stored ? await readFile(path.join(fixtureDir, "pads-audio.bin")) : data;
          assert.deepEqual(
            bytes,
            packHomebrewPbp(disks === 2 ? [expectedImage, expectedImage] : [expectedImage], {
              stored,
              audioStartSector: stored ? data.length / 2352 : undefined,
            }),
          );
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
        const servedWasm = [];
        const wasmChecks = [];
        const servedEmulatorAssets = [];
        const assetChecks = [];
        const page = await context.newPage();
        page.on("response", (response) => {
          const pathname = new URL(response.url()).pathname;
          const asset = assetPaths.find((candidate) => pathname.endsWith(`/emulatorjs/data/${candidate}`));
          if (asset) {
            assetChecks.push(
              response.body().then((body) => {
                servedEmulatorAssets.push({
                  asset,
                  url: response.url(),
                  sha256: createHash("sha256").update(body).digest("hex"),
                });
              }),
            );
          }
          if (/rom-weaver-app[^/]*\.wasm$/.test(new URL(response.url()).pathname)) {
            wasmChecks.push(
              response.body().then((bytes) => {
                const sha256 = createHash("sha256").update(bytes).digest("hex");
                servedWasm.push({ url: response.url(), sha256 });
              }),
            );
          }
        });
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
          const contents =
            core === "psx"
              ? await frame.evaluate(async () => {
                  const fs = window.EJS_emulator.gameManager.FS;
                  const entries = [];
                  for (const name of fs.readdir("/").filter((name) => /\.(bin|cue|m3u)$/i.test(name))) {
                    const bytes = fs.readFile(`/${name}`);
                    entries.push({
                      name,
                      size: bytes.length,
                      sha256: Array.from(
                        new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
                        (byte) => byte.toString(16).padStart(2, "0"),
                      ).join(""),
                      text: /\.(cue|m3u)$/i.test(name) ? new TextDecoder().decode(bytes) : undefined,
                    });
                  }
                  return { selected: window.EJS_emulator.fileName, entries };
                })
              : undefined;
          if (core === "psx") {
            const bins = contents.entries.filter((entry) => /\.bin$/i.test(entry.name));
            const cues = contents.entries.filter((entry) => /\.cue$/i.test(entry.name));
            assert.equal(bins.length, disks);
            assert.equal(cues.length, disks);
            for (const bin of bins) {
              assert.equal(bin.size, expectedImage.length);
              assert.equal(bin.sha256, createHash("sha256").update(expectedImage).digest("hex"));
            }
            for (const cue of cues) {
              assert.match(cue.text, /TRACK 01 MODE2\/2352/);
              if (stored) assert.match(cue.text, /TRACK 02 AUDIO\s+INDEX 00 00:12:10\s+INDEX 01 00:14:10/);
            }
            assert.match(contents.selected, /\.m3u$/i);
          }
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
              let frameHash = 2166136261;
              let padHash = 2166136261;
              let padWhite = 0;
              for (let index = 0; index < pixels.length; index += 4) {
                const [r, g, b] = pixels.subarray(index, index + 3);
                frameHash = Math.imul(frameHash ^ r ^ (g << 8) ^ (b << 16), 16777619);
                const y = Math.floor(index / 4 / image.width);
                if (y > image.height * 0.17 && y < image.height * 0.27) {
                  padHash = Math.imul(padHash ^ r ^ (g << 8) ^ (b << 16), 16777619);
                  if (r > 220 && g > 220 && b > 220) padWhite += 1;
                }
                if (r > 5 && r < 40 && g < 15 && b > 20 && b < 70) purple += 1;
                if (r > 35 && r < 65 && g > 12 && g < 40 && b < 15) brown += 1;
                if (Math.max(r, g, b) > 220 && Math.min(r, g, b) < 25) saturated += 1;
              }
              return {
                brown,
                saturated,
                purple,
                frameHash,
                padHash,
                padWhite,
                width: image.width,
                height: image.height,
              };
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
          if (core === "psp") assert(pixels.purple < 150000, "cube must fail the raycast color oracle");
          let advanced;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            await frame.evaluate(() => new Promise(requestAnimationFrame));
            advanced = await capture("advanced");
            if (advanced.frameHash !== pixels.frameHash) break;
          }
          assert.notEqual(advanced.frameHash, pixels.frameHash, "demo must render successive changing frames");
          await Promise.all([...wasmChecks, ...assetChecks]);
          const nativeAsset = `cores/${core === "psx" ? "pcsx_rearmed" : "ppsspp"}-thread-wasm.data`;
          for (const asset of ["loader.js", nativeAsset]) {
            assert(
              servedEmulatorAssets.some((served) => served.asset === asset),
              `must serve pinned ${asset}`,
            );
          }
          for (const served of servedEmulatorAssets) {
            assert.equal(served.sha256, expectedAssets[served.asset], `served ${served.asset} must match lock`);
          }
          for (const wasm of servedWasm)
            assert.equal(wasm.sha256, expectedWasmHash, "served WASM must match the fresh build");
          if (core === "psx") assert(servedWasm.length > 0, "the application must serve the pinned fresh WASM");
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
          else
            assert(
              held.purple > 150000 && held.purple > pixels.purple * 10,
              "Start must switch the cube to the raycast scene",
            );
          const diskStates = [native];
          const diskFrames = [];
          const verifyRunningDisk = async (label) => {
            const initial = await capture(label);
            assert(initial.brown > 1000, "selected disc must retain the demo scene");
            let next;
            for (let attempt = 0; attempt < 60; attempt += 1) {
              await frame.evaluate(() => new Promise(requestAnimationFrame));
              next = await capture(`${label}-advanced`);
              if (next.frameHash !== initial.frameHash) break;
            }
            assert.notEqual(next.frameHash, initial.frameHash, "selected disc must keep rendering changing frames");
            diskFrames.push({ initial, advanced: next });
          };
          if (disks === 2) {
            await frame.locator("#ejs_disksMenu > button").click();
            await frame.locator("#ejs_disksMenu button[ejs_value='1']").click();
            const second = await frame.evaluate(() => ({
              count: window.EJS_emulator.gameManager.getDiskCount(),
              index: window.EJS_emulator.gameManager.getCurrentDisk(),
            }));
            assert.deepEqual(second, { count: 2, index: 1 });
            diskStates.push(second);
            for (let index = 0; index < 30; index += 1) await frame.evaluate(() => new Promise(requestAnimationFrame));
            await verifyRunningDisk("disk-2");
            const firstDisk = frame.locator("#ejs_disksMenu button[ejs_value='0']");
            if (!(await firstDisk.isVisible())) await frame.locator("#ejs_disksMenu > button").click();
            await firstDisk.click();
            const returned = await frame.evaluate(() => ({
              count: window.EJS_emulator.gameManager.getDiskCount(),
              index: window.EJS_emulator.gameManager.getCurrentDisk(),
            }));
            assert.deepEqual(returned, { count: 2, index: 0 });
            diskStates.push(returned);
            for (let index = 0; index < 30; index += 1) await frame.evaluate(() => new Promise(requestAnimationFrame));
            await verifyRunningDisk("disk-1-return");
          }
          assert.deepEqual(external, [], "pinned assets must not fall back to a remote CDN");
          assert.deepEqual(errors, []);
          report.cases.push({
            name,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            core,
            native,
            diskStates,
            diskFrames,
            contents,
            servedWasm,
            servedEmulatorAssets,
            pixels,
            advanced,
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
