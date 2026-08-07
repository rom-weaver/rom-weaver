#!/usr/bin/env node

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, webkit } from "playwright";
import { DOC_SOURCES, SITE_ORIGIN } from "../src/webapp/docs-routing.mjs";
import { buildStoredZip } from "../tests/wasm/stored-zip-fixture.mjs";
import { summarizeCssCoverage } from "./css-coverage.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(PACKAGE_DIR, "tests", "fixtures");
const AXE_SCRIPT_PATH = path.join(PACKAGE_DIR, "node_modules", "axe-core", "axe.min.js");
const CSS_COVERAGE_BUDGET = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_DIR, "performance-budgets.json"), "utf8"),
).cssCoverage;
const EXPECTED_PATCHED_SHA256 = "43b1cc171d0b795e224072752effd13400f6392d0fab8d0793373cce4b4f46fb";
const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"];
// Derived from the route table, so a new guide is audited without a second edit.
export const computeDocsRouteSlugs = (docSources) => docSources.map((source) => source.slug);
const DOCS_ROUTES = computeDocsRouteSlugs(DOC_SOURCES);
const A11Y_VIEWPORTS = [
  { height: 720, label: "desktop", width: 1280 },
  { height: 844, label: "mobile", width: 390 },
];
const DOWNLOAD_TIMEOUT_MS = 60_000;
const ARCHIVE_STRESS_TIMEOUT_MS = 240_000;
const MANY_ENTRIES_COUNT = 2048;
const MANY_ENTRY_SIZE = 4096;
const E2E_ATTEMPTS = 2;
const A11Y_ONLY = process.argv.includes("--a11y");
const browserName = process.env.ROM_WEAVER_BROWSER || "chromium";
const browserType = { chromium, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported ROM_WEAVER_BROWSER value: ${browserName}`);
const HYDRATION_SETTINGS = JSON.stringify({
  apply: { compression: { threads: 3 } },
  common: { betaToolsEnabled: true },
  create: { compression: { threads: 3 } },
  version: 5,
});

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

// The dev/preview server uses a self-signed certificate, so loopback requests must skip
// verification. Anything that is not loopback keeps full TLS validation - a redirected or
// misconfigured URL should fail loudly rather than silently trust an unknown certificate.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const shouldRejectUnauthorized = (url) => {
  try {
    return !LOOPBACK_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return true;
  }
};

const waitForServer = (url, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const request = https.get(url, { rejectUnauthorized: shouldRejectUnauthorized(url) }, (response) => {
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
    const request = https.get(url, { rejectUnauthorized: shouldRejectUnauthorized(url) }, (response) => {
      response.resume();
      resolve(response.statusCode || 0);
    });
    request.on("error", reject);
  });

const runHydrationAudit = async (createContext, baseUrl) => {
  const context = await createContext({ ignoreHTTPSErrors: true });
  await context.addInitScript((settings) => {
    localStorage.setItem("rom-weaver-settings", settings);
    localStorage.setItem("rom-weaver-theme", "light");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    const audit = {
      identityResolved: false,
      initialTheme: "",
      initialView: "",
      runtime: null,
      runtimeTexts: [],
      threads: null,
      threadTexts: [],
    };
    window.__romWeaverHydrationAudit = audit;
    const sample = () => {
      const active = document.querySelector('[role="tab"][aria-selected="true"]');
      if (!audit.initialView && active) audit.initialView = active.getAttribute("data-mode") || "";
      if (!audit.identityResolved) return;
      const threads = document.querySelector(".masthead-threads");
      const runtime = document.querySelector(".sub-status");
      if (!(threads && runtime)) return;
      if (!audit.threads) {
        audit.threads = threads;
        audit.runtime = runtime;
        audit.initialTheme = document.documentElement.dataset.theme || "";
      }
      const threadText = threads.textContent || "";
      const runtimeText = runtime.textContent || "";
      if (audit.threadTexts.at(-1) !== threadText) audit.threadTexts.push(threadText);
      if (audit.runtimeTexts.at(-1) !== runtimeText) audit.runtimeTexts.push(runtimeText);
    };
    let resolveShellIdentity;
    Object.defineProperty(window, "ROM_WEAVER_RESOLVE_SHELL_IDENTITY", {
      configurable: true,
      get: () => resolveShellIdentity,
      set: (resolver) => {
        resolveShellIdentity = (...args) => {
          const result = resolver(...args);
          audit.identityResolved = true;
          sample();
          return result;
        };
      },
    });
    new MutationObserver(sample).observe(document, { characterData: true, childList: true, subtree: true });
    sample();
  }, HYDRATION_SETTINGS);

  try {
    for (const testCase of [
      { finalView: "patcher", initialView: "patcher", path: "apply/", replayClick: true },
      { finalView: "creator", initialView: "creator", path: "create/" },
      { finalView: "trim", initialView: "patcher", path: "trim/" },
    ]) {
      const page = await context.newPage();
      const failures = [];
      page.on("console", (message) => {
        if (message.type() === "error") failures.push(message.text());
      });
      page.on("pageerror", (error) => failures.push(error.stack || error.message));

      let releaseScripts = () => undefined;
      if (testCase.replayClick) {
        let release;
        const scriptsReleased = new Promise((resolve) => {
          release = resolve;
        });
        releaseScripts = release;
        await page.route(/\/assets\/.*\.js(?:\?.*)?$/, async (route) => {
          await scriptsReleased;
          await route.continue();
        });
        await page.setViewportSize({ height: 852, width: 393 });
      }

      let initialShellLayout = null;
      try {
        const navigation = page.goto(`${baseUrl}${testCase.path}`, { waitUntil: "domcontentloaded" });
        if (testCase.replayClick) {
          const settings = page.getByRole("button", { name: "Settings" });
          await settings.waitFor({ state: "visible" });
          // Standalone iOS paints with device insets before the app bundle can
          // run. Apply representative values to exercise that same first shell
          // geometry instead of only testing the browser-tab zero-inset case.
          await page.addStyleTag({
            content: ".rw-app { --safe-t: 59px; --safe-b: 34px; --pwa-footer-reserve: 16px; }",
          });
          const initialShell = await page.evaluate(() => {
            const root = document.getElementById("webapp-root");
            // The dock is the phone chrome the shell must paint inside the
            // first viewport now that the footer is gone.
            const footer = document.querySelector(".dock")?.getBoundingClientRect();
            const links = document.querySelector(".dock-tab")?.getBoundingClientRect();
            const status = [...document.querySelectorAll(".dock-tab")].at(-1)?.getBoundingClientRect();
            const workflow = document.querySelector("#panel-patcher .workflow-body")?.getBoundingClientRect();
            return {
              footerInFirstViewport:
                !!footer &&
                footer.top < window.innerHeight &&
                footer.bottom <= window.innerHeight &&
                !!links &&
                links.bottom <= window.innerHeight &&
                !!status &&
                status.bottom <= window.innerHeight,
              prerendered: root?.hasAttribute("aria-busy") === true,
              footerTop: footer?.top ?? null,
              workflowTop: workflow?.top ?? null,
            };
          });
          initialShellLayout = initialShell;
          if (!(initialShell.prerendered && initialShell.footerInFirstViewport)) {
            throw new Error(`initial shell dock is not visible: ${JSON.stringify(initialShell)}`);
          }
          await settings.click();
          releaseScripts();
        }
        await navigation;
        await page.waitForFunction((expectedView) => {
          const root = document.getElementById("webapp-root");
          const active = document.querySelector('[role="tab"][aria-selected="true"]');
          return !root?.hasAttribute("aria-busy") && active?.getAttribute("data-mode") === expectedView;
        }, testCase.finalView);
        if (testCase.replayClick) await page.getByRole("dialog").waitFor({ state: "visible" });
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );

        const result = await page.evaluate((initialLayout) => {
          const audit = window.__romWeaverHydrationAudit;
          const root = document.getElementById("webapp-root");
          const footer = document.querySelector(".dock")?.getBoundingClientRect();
          const workflow = document.querySelector("#panel-patcher .workflow-body")?.getBoundingClientRect();
          const workflowStyle = document.querySelector("#panel-patcher .workflow-body");
          return {
            finalTheme: document.documentElement.dataset.theme || "",
            finalView: document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-mode") || "",
            initialTheme: audit.initialTheme,
            initialView: audit.initialView,
            runtimeRetained: document.querySelector(".sub-status") === audit.runtime,
            runtimeTexts: audit.runtimeTexts,
            threadRetained: document.querySelector(".masthead-threads") === audit.threads,
            threadTexts: audit.threadTexts,
            shellHandoffStable:
              !initialLayout ||
              (Math.abs((footer?.top ?? 0) - initialLayout.footerTop) <= 0.5 &&
                Math.abs((workflow?.top ?? 0) - initialLayout.workflowTop) <= 0.5),
            shellSettled: root?.dataset.shellSettled === "true",
            panelAnimation: workflowStyle ? getComputedStyle(workflowStyle).animationName : "",
          };
        }, initialShellLayout);
        const problems = [];
        if (!result.threadRetained) problems.push("thread node was replaced");
        if (!result.runtimeRetained) problems.push("runtime node was replaced");
        if (result.threadTexts.length !== 1 || !result.threadTexts[0]?.includes("3 Threads"))
          problems.push(`thread text changed: ${JSON.stringify(result.threadTexts)}`);
        if (result.runtimeTexts.length !== 1)
          problems.push(`runtime text changed: ${JSON.stringify(result.runtimeTexts)}`);
        if (result.initialTheme !== "light" || result.finalTheme !== "light")
          problems.push(`theme changed: ${result.initialTheme} -> ${result.finalTheme}`);
        if (result.initialView !== testCase.initialView || result.finalView !== testCase.finalView)
          problems.push(`view changed unexpectedly: ${result.initialView} -> ${result.finalView}`);
        if (testCase.replayClick && !result.shellHandoffStable)
          problems.push("prerendered shell moved during hydration");
        if (testCase.replayClick && (!result.shellSettled || result.panelAnimation !== "none"))
          problems.push(`prerendered panel was not settled: ${JSON.stringify(result)}`);
        if (failures.length) problems.push(`browser errors: ${failures.join(" | ")}`);
        if (problems.length)
          throw new Error(
            `${testCase.path} hydration audit failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
          );
        process.stdout.write(`PASS hydration ${testCase.path} (${result.initialView} -> ${result.finalView})\n`);
      } finally {
        releaseScripts();
        await page.close();
      }
    }
  } finally {
    await context.close();
  }
};

/**
 * axe measures composited colour, so an element caught mid-fade reads as a
 * contrast failure that does not exist once the animation lands - and a
 * transition is not something Playwright's "visible" waits on. Settle the
 * finite animations before scanning; the looping ones (the guide's breathing
 * ring, the CTA pulse, the weave drift) never finish and are skipped. Repeated
 * because one animation commonly starts the next - the guide card's arrival
 * begins as its exit ends.
 */
const settleAnimations = async (page) => {
  for (let pass = 0; pass < 3; pass += 1) {
    const settled = await page.evaluate(async () => {
      const running = document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY);
      if (running.length === 0) return true;
      await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
      return false;
    });
    if (settled) return;
  }
};

const waitForStableBox = async (page, locator) => {
  const selector = await locator.evaluate((element) => {
    if (!(element instanceof HTMLElement && element.id)) throw new Error("Stable-layout target needs an element id");
    return `#${CSS.escape(element.id)}`;
  });
  await page.waitForFunction(
    ({ selector: targetSelector }) => {
      const element = document.querySelector(targetSelector);
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const box = [rect.x, rect.y, rect.width, rect.height];
      const previous = globalThis.__romWeaverStableBox;
      const now = performance.now();
      if (previous?.element === element && previous.box.every((value, index) => value === box[index])) {
        return now - previous.since >= 500;
      }
      globalThis.__romWeaverStableBox = { box, element, since: now };
      return false;
    },
    { selector },
    { polling: 50, timeout: 60_000 },
  );
};

const scanLiveApp = async (page, label) => {
  await settleAnimations(page);
  const violations = await page.evaluate(async (tags) => {
    const results = await window.axe.run(document, {
      resultTypes: ["violations"],
      runOnly: { type: "tag", values: tags },
    });
    return results.violations.map((violation) => ({
      help: violation.help,
      id: violation.id,
      nodes: violation.nodes.map((node) => {
        const target = node.target.join(" ");
        const element = document.querySelector(target);
        const rect = element?.getBoundingClientRect();
        // Geometry rules (target size, contrast) are unreadable from a selector
        // alone: what fails is where the box ended up and what is sitting on top
        // of it, and neither survives into the CI log otherwise.
        const covering = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 1) : null;
        return {
          covering:
            covering && covering !== element
              ? `${covering.tagName.toLowerCase()}${covering.className ? `.${String(covering.className).trim().split(/\s+/).join(".")}` : ""}`
              : null,
          rect: rect && {
            bottom: Math.round(rect.bottom),
            height: Math.round(rect.height),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
          },
          reason: node.failureSummary,
          target,
          viewport: { height: window.innerHeight, width: window.innerWidth },
        };
      }),
    }));
  }, A11Y_TAGS);
  if (violations.length) throw new Error(`${label} accessibility violations:\n${JSON.stringify(violations, null, 2)}`);
  process.stdout.write(`PASS accessibility ${label}\n`);
};

export const checkCssCoverage = (entries) => {
  const coverage = summarizeCssCoverage(entries);
  if (coverage.stylesheetCount === 0) throw new Error("CSS coverage did not include a bundled stylesheet");
  const usedPercent = ((coverage.usedBytes / coverage.totalBytes) * 100).toFixed(1);
  const label =
    `${coverage.unusedBytes.toLocaleString()} unused of ${coverage.totalBytes.toLocaleString()} CSS bytes` +
    ` (${usedPercent}% used; maximum ${CSS_COVERAGE_BUDGET.maxUnusedBytes.toLocaleString()} unused)`;
  if (coverage.unusedBytes > CSS_COVERAGE_BUDGET.maxUnusedBytes)
    throw new Error(`CSS coverage budget failed: ${label}`);
  process.stdout.write(`PASS CSS coverage: ${label}\n`);
};

const runAccessibilityAudit = async (createContext, baseUrl) => {
  const context = await createContext({ ignoreHTTPSErrors: true });
  let page = await context.newPage();
  const cssCoverageEntries = [];
  const failures = [];
  const watchPageErrors = () => page.on("pageerror", (error) => failures.push(error.stack || error.message));
  watchPageErrors();
  const setTheme = async (theme) => {
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
      const mastheadTheme = page.locator('button[aria-label^="Switch to "]:visible').first();
      if (await mastheadTheme.count()) {
        await mastheadTheme.click();
      } else {
        await page.getByRole("button", { exact: true, name: "More" }).click();
        await page.getByRole("menuitem", { exact: true, name: "Theme" }).click();
      }
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
    }
  };
  const scanVariants = async (label) => {
    const originalTheme = await page.locator("html").getAttribute("data-theme");
    const originalViewport = page.viewportSize();
    try {
      for (const viewport of A11Y_VIEWPORTS) {
        await page.setViewportSize(viewport);
        for (const theme of ["light", "dark"]) {
          await page.locator("html").evaluate((html, nextTheme) => {
            html.dataset.theme = nextTheme;
          }, theme);
          await scanLiveApp(page, `${label} (${viewport.label}, ${theme})`);
        }
      }
    } finally {
      await page.locator("html").evaluate((html, theme) => {
        html.dataset.theme = theme;
      }, originalTheme);
      if (originalViewport) await page.setViewportSize(originalViewport);
    }
  };
  const installAuditTools = async () => {
    await page.addScriptTag({ path: AXE_SCRIPT_PATH });
    await page.addStyleTag({
      content:
        "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;}" +
        '.rw-app .btn[data-guide-cta="true"]{animation:none!important;}',
    });
  };

  try {
    if (browserName === "chromium") await page.coverage.startCSSCoverage();
    await page.goto(new URL("404.html", baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.locator(".not-found-page").waitFor({ state: "visible" });
    if ((await page.locator('.mode[aria-selected="true"]').count()) !== 0) {
      throw new Error("404 page marks a workflow tab as selected");
    }
    await page.getByRole("link", { name: "Apply a patch" }).waitFor({ state: "visible" });
    await page.getByRole("link", { name: "Browse docs" }).waitFor({ state: "visible" });
    await installAuditTools();
    await scanVariants("not found");
    if (browserName === "chromium") cssCoverageEntries.push(...(await page.coverage.stopCSSCoverage()));
    await page.close();

    page = await context.newPage();
    watchPageErrors();
    if (browserName === "chromium") await page.coverage.startCSSCoverage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });

    // On a mobile Docs reload the trail is already in the prerendered shell.
    // Its fixed position must be viewport-relative before hydration finishes;
    // WebKit otherwise treats the workflow body's entrance translate as its
    // containing block and leaves the bar below the article.
    await page.setViewportSize(A11Y_VIEWPORTS.find((viewport) => viewport.label === "mobile"));
    const docsReloadResponse = await page.goto(new URL("docs/get-started/", baseUrl).href, { waitUntil: "commit" });
    const docsReloadHtml = (await docsReloadResponse?.text()) ?? "";
    if (!docsReloadHtml.includes('class="warp-rail is-initializing"')) {
      throw new Error("Docs route response is missing the static rail initialization state");
    }
    if (!docsReloadHtml.includes('aria-current="true"')) {
      throw new Error("Docs route response is missing the static initial rail marker");
    }
    const docsTrail = page.locator(".docs-trail");
    await docsTrail.waitFor({ state: "attached" });
    const trailGeometry = await docsTrail.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, height: rect.height, viewportHeight: window.innerHeight };
    });
    if (Math.abs(trailGeometry.bottom - trailGeometry.viewportHeight) > 1 || trailGeometry.height <= 0) {
      throw new Error(`Mobile Docs trail is not fixed to the viewport on reload: ${JSON.stringify(trailGeometry)}`);
    }

    // A cold Docs tab load must keep the current panel until the lazy route is
    // ready; otherwise the first frame after the click has no docs navigation.
    const docsNavigationContext = await createContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
    const docsNavigationPage = await docsNavigationContext.newPage();
    try {
      const docsChunkPattern = /\/assets\/docs-page-[^/]+\.js(?:\?.*)?$/;
      let releaseDocsChunk;
      let docsChunkRequest;
      const docsChunkStarted = new Promise((resolve) => {
        docsChunkRequest = resolve;
      });
      const docsChunkReleased = new Promise((resolve) => {
        releaseDocsChunk = resolve;
      });
      await docsNavigationPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await docsNavigationPage.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });
      await docsNavigationPage.route(docsChunkPattern, async (route) => {
        docsChunkRequest();
        await docsChunkReleased;
        await route.continue();
      });
      await docsNavigationPage.locator('[role="tab"][data-mode="docs"]:visible').first().click();
      await docsChunkStarted;
      await docsNavigationPage
        .locator('.mode[role="tab"][aria-selected="true"][data-mode="patcher"]')
        .waitFor({ state: "visible" });
      if ((await docsNavigationPage.locator(".docs-rails .guide-nav").count()) !== 0) {
        throw new Error("Docs navigation mounted before its lazy route was ready");
      }
      releaseDocsChunk();
      await docsNavigationPage.locator(".docs-rails .guide-nav").waitFor({ state: "visible" });
      await docsNavigationPage
        .locator('.mode[role="tab"][aria-selected="true"][data-mode="docs"]')
        .waitFor({ state: "visible" });
    } finally {
      await docsNavigationContext.close();
    }
    await page.setViewportSize(A11Y_VIEWPORTS.find((viewport) => viewport.label === "desktop"));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });
    await installAuditTools();

    for (const viewport of A11Y_VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByRole("dialog").waitFor({ state: "visible" });
        await scanLiveApp(page, `Settings (${viewport.label}, ${theme})`);
        const betaTools = page.locator("#settings-beta-tools-enabled");
        if (!(await betaTools.isChecked())) await betaTools.check();
        await page.getByRole("button", { exact: true, name: "Save" }).click();
      }
      for (const tab of ["patcher", "creator", "trim"]) {
        await page.locator(`[role="tab"][data-mode="${tab}"]:visible`).first().click();
        await page.locator(`#panel-${tab}:not([hidden])`).waitFor({ state: "visible" });
        for (const theme of ["light", "dark"]) {
          await setTheme(theme);
          await scanLiveApp(page, `${tab} (${viewport.label}, ${theme})`);
        }
      }
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Tools", exact: true }).click();
      await page.locator("#panel-tools:not([hidden])").waitFor({ state: "visible" });
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        await scanLiveApp(page, `tools (${viewport.label}, ${theme})`);
      }
    }

    await page.setViewportSize(A11Y_VIEWPORTS[0]);
    await setTheme("light");
    await page.locator('[role="tab"][data-mode="patcher"]:visible').first().click();

    const infoButton = page.locator(".info-btn").first();
    await infoButton.click();
    await page.locator(".info-pop").waitFor({ state: "visible" });
    await scanVariants("info popover");
    await infoButton.click();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    const codecCombobox = page.locator(".codec-combobox input").first();
    await codecCombobox.click();
    await page.locator(".codec-combobox-list").waitFor({ state: "visible" });
    await scanVariants("codec combobox");
    await page.locator(".codec-combobox-option").first().click();
    await page.getByRole("button", { exact: true, name: "Save" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Logs", exact: true }).click();
    const logDialog = page.locator("dialog.log-dlg");
    await logDialog.waitFor({ state: "visible" });
    await scanVariants("log dialog");
    await logDialog.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Reset" }).click();
    await page.getByRole("dialog", { name: "Reset the page?" }).waitFor({ state: "visible" });
    await scanLiveApp(page, "reset confirmation (desktop, light)");
    await page.getByRole("button", { name: "Stay here" }).click();

    const romFixture = fs.readFileSync(path.join(FIXTURE_DIR, "archive_sources", "game.bin"));
    await page.locator("#rom-weaver-input-file-unified").setInputFiles([
      { buffer: romFixture, mimeType: "application/octet-stream", name: "alpha.bin" },
      { buffer: romFixture, mimeType: "application/octet-stream", name: "beta.bin" },
    ]);
    const selectionDialog = page.locator(".rw-modal.select-modal");
    await selectionDialog.waitFor({ state: "visible", timeout: 60_000 });
    await scanVariants("candidate selection");
    await selectionDialog.locator("button.dlg-x").click();
    await selectionDialog.waitFor({ state: "hidden" });

    await page.setViewportSize(A11Y_VIEWPORTS[0]);
    await setTheme("light");
    const onboardingChip = page.getByRole("button", { name: "New here?" });
    await onboardingChip.waitFor({ state: "visible", timeout: 60_000 });
    await onboardingChip.click();
    const guidedApply = page.getByRole("link", { name: "Start guided Apply" });
    await guidedApply.waitFor({ state: "visible", timeout: 60_000 });
    await guidedApply.click();
    const tutorial = page.locator(".sample-tutorial-dialog");
    await tutorial.waitFor({ state: "visible" });
    await scanLiveApp(page, "guided Apply loading (desktop, light)");
    for (let step = 1; step <= 4; step += 1) {
      await tutorial.getByText(`Guided workbench · ${step}/4`).waitFor({ state: "visible", timeout: 60_000 });
      await scanVariants(`guided Apply ${step}/4`);
      if (step === 4) {
        await page.locator("#rom-weaver-button-apply").click();
      } else {
        await tutorial.getByRole("button", { name: "Continue" }).click();
      }
    }
    await tutorial.waitFor({ state: "hidden" });

    await page.goto(new URL("weave?guide=bundle", baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });
    await installAuditTools();
    await tutorial.waitFor({ state: "visible" });
    await scanLiveApp(page, "guided Bundle loading (desktop, light)");
    for (let step = 1; step <= 4; step += 1) {
      await tutorial.getByText(`Guided workbench · ${step}/4`).waitFor({ state: "visible", timeout: 60_000 });
      await scanVariants(`guided Bundle ${step}/4`);
      if (step === 4) {
        await page.getByRole("button", { name: "Create ZIP Bundle", exact: true }).click();
        const downloadButton = page.getByRole("button", { name: "Download ZIP Bundle", exact: true });
        await downloadButton.waitFor({ state: "visible", timeout: 60_000 });
        await waitForStableBox(page, downloadButton);
        await downloadButton.hover();
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
          downloadButton.click(),
        ]);
        if (!download.suggestedFilename().endsWith(".zip")) {
          throw new Error(`guided Bundle downloaded ${download.suggestedFilename()}; expected a ZIP`);
        }
      } else {
        await tutorial.getByRole("button", { name: "Continue" }).click();
      }
    }
    await tutorial.waitFor({ state: "hidden" });

    await page.setViewportSize(A11Y_VIEWPORTS[0]);
    await setTheme("light");
    const firstPatchMenu = page.getByRole("button", { name: "Patch actions" }).first();
    await firstPatchMenu.click();
    await page.getByRole("menuitem", { name: "Edit details" }).click();
    await page.getByRole("button", { name: "Done editing patch details" }).waitFor({ state: "visible" });
    await scanVariants("patch details editor");
    await page.getByRole("button", { name: "Done editing patch details" }).click();

    await page.setViewportSize(A11Y_VIEWPORTS[0]);
    await setTheme("light");
    const firstPatchHandle = page.getByRole("button", { name: /^Patch 1 of 2\./ });
    await firstPatchHandle.focus();
    await firstPatchHandle.press("ArrowDown");
    await page
      .getByRole("button", { name: /^Patch 2 of 2\./ })
      .first()
      .waitFor({ state: "visible" });
    await scanLiveApp(page, "reordered patches (desktop, light)");
    const editablePatchHandle = page.getByRole("button", { name: /^Patch 1 of 2\./ });
    await editablePatchHandle.click();
    await page.getByRole("spinbutton", { name: /^Edit patch position/ }).waitFor({ state: "visible" });
    await scanVariants("patch position editor");
    await page.getByRole("spinbutton", { name: /^Edit patch position/ }).press("Escape");

    await page.setViewportSize(A11Y_VIEWPORTS[0]);
    await setTheme("light");
    await page.locator('[role="tab"][data-mode="creator"]:visible').first().click();
    const createOnboardingChip = page.getByRole("button", { name: "New here?" });
    await createOnboardingChip.waitFor({ state: "visible" });
    await createOnboardingChip.click();
    const guidedCreate = page.getByRole("link", { name: "Start guided Create" });
    await guidedCreate.waitFor({ state: "visible" });
    await guidedCreate.click();
    await tutorial.waitFor({ state: "visible" });
    await scanLiveApp(page, "guided Create loading (desktop, light)");
    for (let step = 1; step <= 4; step += 1) {
      await tutorial.getByText(`Guided workbench · ${step}/4`).waitFor({ state: "visible", timeout: 60_000 });
      await scanVariants(`guided Create ${step}/4`);
      if (step === 4) {
        await page.locator("#patch-builder-button-create").click();
      } else {
        await tutorial.getByRole("button", { name: "Continue" }).click();
      }
    }
    await tutorial.waitFor({ state: "hidden" });

    // Last, because each guide is its own served document: the audits above all
    // run against the app page and would have to re-enter it afterwards.
    // Loading them for real rather than switching to them in-app is the only
    // way a hydration mismatch against the served HTML surfaces as a page error.
    // Coverage is per-document and resets on navigation, so bank what the app
    // page used before leaving it - otherwise only the last guide's sheet
    // survives to the budget check and the whole app's CSS reads as unused.
    if (browserName === "chromium") cssCoverageEntries.push(...(await page.coverage.stopCSSCoverage()));

    let retargetedSamples = 0;
    for (const slug of DOCS_ROUTES) {
      if (browserName === "chromium") await page.coverage.startCSSCoverage();
      await page.goto(`${baseUrl.replace(/\/$/, "")}/${slug}`, { waitUntil: "domcontentloaded" });
      await page.locator(".docs-article h1").waitFor({ state: "visible" });
      await installAuditTools();
      const headings = await page.locator("h1").count();
      assertSingleDocsHeading(headings, slug);
      // This origin is not production, so once the page is live every sample
      // download has to have moved to it. The served HTML still names
      // production, which is the right answer for a crawler but the wrong one
      // for anyone copying a command out of a beta or preview deployment.
      await page.waitForFunction(() => !document.getElementById("webapp-root")?.hasAttribute("aria-busy"));
      const samples = await page.evaluate((productionOrigin) => {
        // Origins are compared after parsing so a lookalike host such as
        // `rom-weaver.com.example` can never read as either origin.
        const origins = [...document.querySelectorAll(".docs-article pre code")].map((block) =>
          (block.textContent || "")
            .match(/https?:\/\/[^\s"'<>]+/g)
            ?.flatMap((value) => (URL.canParse(value) ? [new URL(value).origin] : [])),
        );
        const countBlocksNaming = (origin) => origins.filter((block) => block?.includes(origin)).length;
        return {
          local: countBlocksNaming(location.origin),
          production: countBlocksNaming(productionOrigin),
        };
      }, SITE_ORIGIN);
      assertNoProductionDocsSamples(samples, slug);
      retargetedSamples += samples.local;
      await scanVariants(slug);
      if (browserName === "chromium") cssCoverageEntries.push(...(await page.coverage.stopCSSCoverage()));
    }
    // Without this the checks above pass just as happily when the swap stops
    // running and no guide offers a sample download at all.
    if (!retargetedSamples) throw new Error("no guide sample was retargeted to the serving origin");
    process.stdout.write(`PASS docs samples retargeted (${retargetedSamples} blocks)\n`);

    if (failures.length) throw new Error(`live app accessibility audit page errors:\n${failures.join("\n")}`);
    // Every page above banked its own coverage as it finished; nothing is still
    // recording here.
    if (browserName === "chromium") checkCssCoverage(cssCoverageEntries);
  } finally {
    await context.close();
  }
};

export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// Every docs route must render exactly one top-level heading; extracted so
// the invariant (and its exact message) is pinned independently of the live
// Playwright walk that calls it once per route in DOCS_ROUTES.
export const assertSingleDocsHeading = (headingCount, slug) => {
  if (headingCount !== 1) throw new Error(`${slug} rendered ${headingCount} level-one headings; expected exactly 1`);
};

// A docs route running against a non-production origin must retarget every
// sample download away from production - extracted for the same reason as
// assertSingleDocsHeading above.
export const assertNoProductionDocsSamples = (samples, slug) => {
  if (samples.production) throw new Error(`${slug} still downloads ${samples.production} sample(s) from production`);
};

// Pure half of createWorkerReuseCorpus's manifest.json: the one deterministic
// "case" entry (payload/archive bytes in, sha256-pinned metadata out), split
// out so it is testable without touching the filesystem or a wall-clock
// timestamp.
export const buildWorkerReuseManifestCase = (archive, payload) => ({
  compressedBytes: archive.byteLength,
  entryCount: MANY_ENTRIES_COUNT,
  expectedSha256: sha256(payload),
  fileName: "many-entries.zip",
  id: "many-entries",
  kind: "generated",
  sha256: sha256(archive),
  uncompressedBytes: MANY_ENTRIES_COUNT * MANY_ENTRY_SIZE,
  url: "/__rom_weaver_corpus__/files/many-entries.zip",
});

const createWorkerReuseCorpus = () => {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-worker-reuse-"));
  const filesDir = path.join(corpusDir, "files");
  fs.mkdirSync(filesDir);
  const archive = buildStoredZip(MANY_ENTRIES_COUNT, MANY_ENTRY_SIZE);
  const archivePath = path.join(filesDir, "many-entries.zip");
  fs.writeFileSync(archivePath, archive);
  const payload = Uint8Array.from({ length: MANY_ENTRY_SIZE }, (_, index) => index & 0xff);
  fs.writeFileSync(
    path.join(corpusDir, "manifest.json"),
    `${JSON.stringify({
      cases: [buildWorkerReuseManifestCase(archive, payload)],
      generatedAt: new Date().toISOString(),
      version: 1,
    })}\n`,
  );
  return corpusDir;
};

const configureUncompressedOutput = async (page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#settings-default-compression").selectOption("none");
  await page.getByRole("button", { name: "Save" }).click();
};

const runApplyJourney = async (createContext, baseUrl, name, fixtureNames) => {
  const context = await createContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
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
    // the real ready-state copy ("Apply & download") rather than just enabledness.
    await page.waitForFunction(() => {
      const button = document.getElementById("rom-weaver-button-apply");
      return button instanceof HTMLButtonElement && !button.disabled && /apply/i.test(button.textContent || "");
    });

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
      apply.click(),
    ]);
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

const runArchiveStressSmoke = async (createContext, baseUrl) => {
  const context = await createContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
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
    await page.goto(`${baseUrl}mobile-safari-matrix.html?profile=stress&cases=many-entries`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => typeof window.ROM_WEAVER_IOS_SAFARI_MATRIX?.run === "function");
    await page.evaluate(() => {
      void window.ROM_WEAVER_IOS_SAFARI_MATRIX?.run("stress");
    });
    await page.waitForFunction(
      () => {
        const status = window.ROM_WEAVER_IOS_SAFARI_MATRIX?.getReport()?.status;
        return status === "passed" || status === "failed";
      },
      undefined,
      { timeout: ARCHIVE_STRESS_TIMEOUT_MS },
    );
    const report = await page.evaluate(() => window.ROM_WEAVER_IOS_SAFARI_MATRIX?.getReport());
    if (report?.status !== "passed") throw new Error(`archive stress smoke failed: ${JSON.stringify(report)}`);
    const succeeded = report.result?.steps?.filter((step) => step.status === "succeeded") || [];
    if (succeeded.length !== 1 || succeeded[0]?.name !== "many-entries") {
      throw new Error(`archive stress smoke ran the wrong cases: ${JSON.stringify(succeeded)}`);
    }
    const wakeLockCalls = await page.evaluate(() => window.__romWeaverWakeLockTest);
    if (wakeLockCalls?.requests !== 1 || wakeLockCalls?.releases !== 1) {
      throw new Error(`archive stress wake lock lifecycle failed: ${JSON.stringify(wakeLockCalls)}`);
    }
    process.stdout.write(`PASS archive worker reuse (${report.result?.durationMs || 0}ms)\n`);
  } finally {
    await context.close();
  }
};

const createBrowserContextFactory = async (browserType, browserName) => {
  const persistentContextDirs = [];
  // This suite audits the app and workflows, not PWA caching. Blocking workers
  // avoids a WebKit service-worker certificate race across the preview ports.
  const createContextOptions = (options) => ({ serviceWorkers: "block", ...options });
  if (browserName === "webkit") {
    return {
      browser: null,
      createContext: async (options) => {
        const userDataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "rom-weaver-webkit-e2e-"));
        persistentContextDirs.push(userDataDir);
        return browserType.launchPersistentContext(userDataDir, {
          ...createContextOptions(options),
          headless: true,
        });
      },
      persistentContextDirs,
    };
  }
  const browser = await browserType.launch({ headless: true });
  return {
    browser,
    createContext: (options) => browser.newContext(createContextOptions(options)),
    persistentContextDirs,
  };
};

const startServer = (mode, port, corpusDir) => {
  const server = childProcess.spawn(process.execPath, ["scripts/dev-server.mjs", mode, "--port", String(port)], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...(corpusDir ? { ROM_WEAVER_E2E_CORPUS_DIR: corpusDir } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { output: () => output, server };
};

const main = async () => {
  const previewPort = await reservePort();
  let devPort = await reservePort();
  while (devPort === previewPort) devPort = await reservePort();
  const host = browserName === "webkit" ? "localhost" : "127.0.0.1";
  const previewBaseUrl = `https://${host}:${previewPort}/`;
  const devBaseUrl = `https://${host}:${devPort}/`;
  const temporaryCorpusDir =
    browserName === "chromium" && !process.env.ROM_WEAVER_E2E_CORPUS_DIR ? createWorkerReuseCorpus() : null;
  const corpusDir = process.env.ROM_WEAVER_E2E_CORPUS_DIR || temporaryCorpusDir;
  const preview = startServer("preview", previewPort);
  const dev = startServer("dev", devPort, corpusDir);

  try {
    await Promise.all([waitForServer(previewBaseUrl), waitForServer(devBaseUrl)]);
    if (corpusDir) {
      const traversalStatus = await requestStatus(`${devBaseUrl}__rom_weaver_corpus__/files/%2e%2e%2fmanifest.json`);
      if (traversalStatus !== 403) throw new Error(`corpus traversal returned ${traversalStatus}, expected 403`);
      const unlistedStatus = await requestStatus(`${devBaseUrl}__rom_weaver_corpus__/files/not-listed.zip`);
      if (unlistedStatus !== 404) throw new Error(`unlisted corpus file returned ${unlistedStatus}, expected 404`);
    }
    const { browser, createContext, persistentContextDirs } = await createBrowserContextFactory(
      browserType,
      browserName,
    );
    try {
      await runHydrationAudit(createContext, previewBaseUrl);
      await runAccessibilityAudit(createContext, previewBaseUrl);
      if (A11Y_ONLY) return;
      await runApplyJourney(createContext, devBaseUrl, "raw apply/download", [
        "archive_sources/game.bin",
        "archive_sources/change.ips",
      ]);
      await runApplyJourney(createContext, devBaseUrl, "archive routing/apply/download", [
        "archives/one-rom.zip",
        "archives/one-patch.7z",
      ]);
      if (browserName === "chromium" && corpusDir) await runArchiveStressSmoke(createContext, devBaseUrl);
    } finally {
      await browser?.close();
      for (const userDataDir of persistentContextDirs) fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  } catch (error) {
    const serverOutput = [preview.output(), dev.output()].filter((output) => output.trim()).join("\n");
    if (serverOutput) process.stderr.write(`${serverOutput.trim()}\n`);
    throw error;
  } finally {
    preview.server.kill("SIGTERM");
    dev.server.kill("SIGTERM");
    if (temporaryCorpusDir) fs.rmSync(temporaryCorpusDir, { force: true, recursive: true });
  }
};

const runWithRetry = async () => {
  childProcess.execFileSync("npm", ["run", "build"], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ROM_WEAVER_CHANNEL: process.env.ROM_WEAVER_CHANNEL || "dev" },
    stdio: "inherit",
  });
  for (let attempt = 1; attempt <= E2E_ATTEMPTS; attempt += 1) {
    try {
      await main();
      return;
    } catch (error) {
      if (attempt === E2E_ATTEMPTS) throw error;
      process.stderr.write(
        `Webapp E2E attempt ${attempt} failed; retrying once with a fresh browser:\n${error?.message || error}\n`,
      );
    }
  }
};

// Guards direct execution (`node scripts/run-webapp-e2e.mjs`, or via the
// `test:e2e:webapp*`/`test:e2e:a11y` npm scripts) from module import - the
// unit tests in run-webapp-e2e.test.mjs import this file for its exported
// pure helpers and must not trigger a full browser E2E run as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWithRetry().catch((error) => {
    process.stderr.write(`${error?.stack || String(error)}\n`);
    process.exitCode = 1;
  });
}
