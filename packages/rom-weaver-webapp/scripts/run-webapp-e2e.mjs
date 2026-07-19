#!/usr/bin/env node

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(PACKAGE_DIR, "tests", "fixtures");
const AXE_SCRIPT_PATH = path.join(PACKAGE_DIR, "node_modules", "axe-core", "axe.min.js");
const EXPECTED_PATCHED_SHA256 = "43b1cc171d0b795e224072752effd13400f6392d0fab8d0793373cce4b4f46fb";
const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"];
const A11Y_ONLY = process.argv.includes("--a11y");
const browserName = process.env.ROM_WEAVER_BROWSER || "chromium";
const browserType = { chromium, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported ROM_WEAVER_BROWSER value: ${browserName}`);

const reservePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const waitForServer = (url, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const request = https.get(url, { rejectUnauthorized: false }, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) {
          resolve();
          return;
        }
        setTimeout(attempt, 100);
      });
      request.on("error", (error) => {
        if (Date.now() >= deadline) reject(error);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });

const requestStatus = (url) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve(response.statusCode || 0);
    });
    request.on("error", reject);
  });

const scanLiveApp = async (page, label) => {
  const violations = await page.evaluate(async (tags) => {
    const results = await window.axe.run(document, {
      resultTypes: ["violations"],
      runOnly: { type: "tag", values: tags },
    });
    return results.violations.map((violation) => ({
      help: violation.help,
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    }));
  }, A11Y_TAGS);
  if (violations.length) throw new Error(`${label} accessibility violations:\n${JSON.stringify(violations, null, 2)}`);
  process.stdout.write(`PASS accessibility ${label}\n`);
};

const runAccessibilityAudit = async (browser, baseUrl) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.stack || error.message));
  const setTheme = async (theme) => {
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
      await page.locator('button[aria-label^="Switch to "]').click();
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
    }
  };

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });
    await page.addScriptTag({ path: AXE_SCRIPT_PATH });
    await page.addStyleTag({
      content:
        "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;}",
    });

    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await scanLiveApp(page, `empty Apply (${theme})`);
    }

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await scanLiveApp(page, "Settings (dark)");
    const betaTools = page.locator("#settings-beta-tools-enabled");
    if (!(await betaTools.isChecked())) await betaTools.check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await setTheme("light");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await scanLiveApp(page, "Settings (light)");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    for (const tab of ["patcher", "creator", "trim"]) {
      await page.locator(`[role="tab"][data-mode="${tab}"]`).click();
      await page.locator(`#panel-${tab}:not([hidden])`).waitFor({ state: "visible" });
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        await scanLiveApp(page, `${tab} (${theme})`);
      }
    }
    if (failures.length) throw new Error(`live app accessibility audit page errors:\n${failures.join("\n")}`);
  } finally {
    await context.close();
  }
};

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const configureUncompressedOutput = async (page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#settings-default-compression").selectOption("none");
  await page.getByRole("button", { name: "Save" }).click();
};

const runApplyJourney = async (browser, baseUrl, name, fixtureNames) => {
  const context = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.stack || error.message));
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });
    await configureUncompressedOutput(page);
    await page
      .locator("#rom-weaver-input-file-unified")
      .setInputFiles(fixtureNames.map((fixture) => path.join(FIXTURE_DIR, fixture)));

    const apply = page.locator("#rom-weaver-button-apply");
    await apply.waitFor({ state: "visible" });
    // The label distinguishes the ready state from the in-flight one, so match
    // the real ready-state copy ("Weave & download") rather than just enabledness.
    await page.waitForFunction(() => {
      const button = document.getElementById("rom-weaver-button-apply");
      return button instanceof HTMLButtonElement && !button.disabled && /weave/i.test(button.textContent || "");
    });

    const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
    await apply.click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error(`${name}: Playwright did not expose the downloaded file`);
    const bytes = fs.readFileSync(downloadPath);
    const digest = sha256(bytes);
    if (digest !== EXPECTED_PATCHED_SHA256) {
      throw new Error(`${name}: output sha256 ${digest} did not match ${EXPECTED_PATCHED_SHA256}`);
    }
    if (!download.suggestedFilename().endsWith(".bin")) {
      throw new Error(`${name}: expected a raw .bin download, got ${download.suggestedFilename()}`);
    }
    if (failures.length) throw new Error(`${name}: uncaught page error\n${failures.join("\n")}`);
    process.stdout.write(`PASS ${name} (${download.suggestedFilename()}, ${bytes.byteLength} bytes)\n`);
  } finally {
    await context.close();
  }
};

const runArchiveStressSmoke = async (browser, baseUrl) => {
  const context = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    const calls = { releases: 0, requests: 0 };
    Object.defineProperty(window, "__romWeaverWakeLockTest", { value: calls });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          calls.requests += 1;
          const sentinel = new EventTarget();
          sentinel.released = false;
          sentinel.release = async () => {
            if (sentinel.released) return;
            sentinel.released = true;
            calls.releases += 1;
            sentinel.dispatchEvent(new Event("release"));
          };
          return sentinel;
        },
      },
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}mobile-safari-matrix.html?profile=stress`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.ROM_WEAVER_IOS_SAFARI_MATRIX?.run === "function");
    await page.evaluate(() => window.ROM_WEAVER_IOS_SAFARI_MATRIX?.run("stress"));
    const report = await page.evaluate(() => window.ROM_WEAVER_IOS_SAFARI_MATRIX?.getReport());
    if (report?.status !== "passed") throw new Error(`archive stress smoke failed: ${JSON.stringify(report)}`);
    const wakeLockCalls = await page.evaluate(() => window.__romWeaverWakeLockTest);
    if (wakeLockCalls?.requests !== 1 || wakeLockCalls?.releases !== 1) {
      throw new Error(`archive stress wake lock lifecycle failed: ${JSON.stringify(wakeLockCalls)}`);
    }
    process.stdout.write(`PASS archive stress smoke (${report.result?.passedSteps || 0} cases)\n`);
  } finally {
    await context.close();
  }
};

const main = async () => {
  const port = await reservePort();
  const baseUrl = `https://127.0.0.1:${port}/`;
  const server = childProcess.spawn(process.execPath, ["scripts/dev-server.mjs", "--port", String(port)], {
    cwd: PACKAGE_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });

  try {
    await waitForServer(baseUrl);
    if (process.env.ROM_WEAVER_E2E_CORPUS_DIR) {
      const traversalStatus = await requestStatus(`${baseUrl}__rom_weaver_corpus__/files/%2e%2e%2fmanifest.json`);
      if (traversalStatus !== 403) throw new Error(`corpus traversal returned ${traversalStatus}, expected 403`);
      const unlistedStatus = await requestStatus(`${baseUrl}__rom_weaver_corpus__/files/not-listed.zip`);
      if (unlistedStatus !== 404) throw new Error(`unlisted corpus file returned ${unlistedStatus}, expected 404`);
    }
    const browser = await browserType.launch({ headless: true });
    try {
      await runAccessibilityAudit(browser, baseUrl);
      if (A11Y_ONLY) return;
      await runApplyJourney(browser, baseUrl, "raw apply/download", [
        "archive_sources/game.bin",
        "archive_sources/change.ips",
      ]);
      await runApplyJourney(browser, baseUrl, "archive routing/apply/download", [
        "archives/one-rom.zip",
        "archives/one-patch.7z",
      ]);
      if (process.env.ROM_WEAVER_E2E_CORPUS_DIR) await runArchiveStressSmoke(browser, baseUrl);
    } finally {
      await browser.close();
    }
  } catch (error) {
    if (serverOutput.trim()) process.stderr.write(`${serverOutput.trim()}\n`);
    throw error;
  } finally {
    server.kill("SIGTERM");
  }
};

main().catch((error) => {
  process.stderr.write(`${error?.stack || String(error)}\n`);
  process.exitCode = 1;
});
