#!/usr/bin/env node

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, webkit } from "playwright";
import { DOC_SOURCES, SITE_ORIGIN } from "../src/webapp/docs-routing.mjs";
import { buildStoredZip } from "../tests/wasm/stored-zip-fixture.mjs";
import { summarizeCssCoverage } from "./css-coverage.mjs";
import { createGuidedLoadingAudit } from "./guided-loading-audit.mjs";

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
export const hasVisiblePrerenderedShell = (layout) => layout.prerendered && layout.dockInFirstViewport;
const DOCS_ROUTES = computeDocsRouteSlugs(DOC_SOURCES);
const LINK_AUDIT_WORKFLOW_ROUTES = [
  "",
  "apply-patches",
  "create-patch",
  "checksum",
  "compress",
  "identify-rom",
  "test-rom",
  "bundle-patches",
  "extract",
  "trim-rom",
  "ppf-undo",
  "save-editor",
  "whats-new",
  "apply",
  "create",
  "identify",
  "test",
  "bundle",
  "trim",
  "tools",
];
export const computeLinkAuditRoutes = (docSources) => [
  ...new Set([...LINK_AUDIT_WORKFLOW_ROUTES, ...computeDocsRouteSlugs(docSources)]),
];
const LINK_AUDIT_ROUTES = computeLinkAuditRoutes(DOC_SOURCES);
const A11Y_VIEWPORTS = [
  { height: 720, label: "desktop", width: 1280 },
  { height: 844, label: "mobile", width: 390 },
];
const DOWNLOAD_TIMEOUT_MS = 60_000;
const ARCHIVE_STRESS_TIMEOUT_MS = 240_000;
const MANY_ENTRIES_COUNT = 2048;
const MANY_ENTRY_SIZE = 4096;
const E2E_ATTEMPTS = 2;
const E2E_SHARD_FLAGS = ["--a11y", "--links", "--journeys", "--journeys-raw", "--journeys-archive"];
const PREBUILT_WEBAPP_CHANNEL = "prod";
const PREBUILT_WEBAPP_DIST_FILES = ["index.html", "manifest.json"];
export const resolveE2EShard = (args) => {
  const requested = args.filter((arg) => E2E_SHARD_FLAGS.includes(arg));
  if (requested.length > 1) {
    throw new Error(`Use only one E2E shard: ${E2E_SHARD_FLAGS.slice(0, -1).join(", ")}, or ${E2E_SHARD_FLAGS.at(-1)}`);
  }
  return requested[0]?.slice(2) || "all";
};
export const resolveE2EBuild = (environment) => {
  if (environment.ROM_WEAVER_E2E_USE_PREBUILT_DIST !== "1") {
    return { channel: environment.ROM_WEAVER_CHANNEL || "dev", source: "build" };
  }
  if (environment.ROM_WEAVER_CHANNEL !== PREBUILT_WEBAPP_CHANNEL) {
    throw new Error(
      `ROM_WEAVER_E2E_USE_PREBUILT_DIST=1 requires ROM_WEAVER_CHANNEL=${PREBUILT_WEBAPP_CHANNEL}; webapp-dist is a production bundle`,
    );
  }
  return { channel: PREBUILT_WEBAPP_CHANNEL, source: "prebuilt" };
};
export const assertPrebuiltWebappDist = (readFile) => {
  const files = new Map();
  for (const file of PREBUILT_WEBAPP_DIST_FILES) {
    try {
      files.set(file, readFile(file));
    } catch (error) {
      throw new Error(`webapp-dist is missing ${file}: ${error?.message || error}`);
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(files.get("manifest.json"));
  } catch (error) {
    throw new Error(`webapp-dist has an invalid manifest.json: ${error?.message || error}`);
  }
  if (manifest.name !== "rom-weaver" || manifest.short_name !== "rom-weaver") {
    throw new Error("webapp-dist is not a production bundle: manifest.json has a channel-specific name");
  }
};
const E2E_SHARD = resolveE2EShard(process.argv.slice(2));
const RUN_AUDITS = E2E_SHARD === "all" || E2E_SHARD === "a11y";
const RUN_LINK_AUDIT = E2E_SHARD === "all" || E2E_SHARD === "links";
const RUN_RAW_JOURNEY = E2E_SHARD === "all" || E2E_SHARD === "journeys" || E2E_SHARD === "journeys-raw";
const RUN_ARCHIVE_JOURNEY = E2E_SHARD === "all" || E2E_SHARD === "journeys" || E2E_SHARD === "journeys-archive";
const browserName = process.env.ROM_WEAVER_BROWSER || "chromium";
const browserType = { chromium, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported ROM_WEAVER_BROWSER value: ${browserName}`);
const systemChromeLaunchOptions =
  browserName === "chromium" && process.env.ROM_WEAVER_SYSTEM_CHROME === "1" ? { channel: "chrome" } : {};
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

const waitForServer = (url, timeoutMs = 60_000) =>
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

const requestStatus = (url, { headers = {}, maxRedirects = 5 } = {}) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, { headers, rejectUnauthorized: shouldRejectUnauthorized(url) }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      response.resume();
      // Link checks MUST follow redirects so a stale destination cannot hide behind a successful 3xx response.
      if (status >= 300 && status < 400 && location) {
        if (maxRedirects === 0) {
          reject(new Error(`too many redirects while requesting ${url}`));
          return;
        }
        requestStatus(new URL(location, url).href, { headers, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      resolve(status);
    });
    request.on("error", reject);
  });

const openSettingsPanel = async (page) => {
  // Phones reach Settings through the dock's App button; desktop keeps the header tool.
  const settings = page.locator(".dock-app:visible, .topbar-tools .settings-tool:visible");
  await settings.first().click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
};

const runHydrationAudit = async (createContext, baseUrl) => {
  const context = await createContext({ ignoreHTTPSErrors: true });
  await context.addInitScript((settings) => {
    localStorage.setItem("rom-weaver-settings", settings);
    localStorage.setItem("rom-weaver-theme", "light");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    const audit = {
      identityResolved: false,
      resolverCalls: 0,
      initialTheme: "",
      initialView: "",
      runtime: null,
      runtimeTexts: [],
      threads: null,
      threadTexts: [],
    };
    window.__romWeaverHydrationAudit = audit;
    const sample = () => {
      const active = document.querySelector('.side-nav [aria-current="page"]');
      if (!audit.initialView && active) audit.initialView = active.id.replace(/^tab-/, "");
      if (!audit.identityResolved) return;
      const threads = document.querySelector(".panel-threads-btn");
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
          audit.resolverCalls += 1;
          audit.identityResolved = audit.resolverCalls === 2;
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
      { finalView: "patcher", initialView: "patcher", path: "apply-patches/", replayClick: true },
      { finalView: "creator", initialView: "creator", path: "create-patch/" },
      { finalView: "trim", initialView: "trim", path: "trim-rom/" },
      { finalView: "patcher", initialView: "patcher", path: "apply/", replayClick: true },
      { finalView: "creator", initialView: "creator", path: "create/" },
      { finalView: "trim", initialView: "trim", path: "trim/" },
      { finalView: "bundle", initialView: "bundle", path: "bundle-patches?guide=bundle" },
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
        // The goto stays un-awaited while the replayClick steps run against the
        // prerendered shell. If one of those steps throws, the finally below
        // closes the page and this promise rejects with nobody awaiting it -
        // an unhandled rejection that kills the process, masking the real error
        // and skipping the retry attempt. The await further down still observes
        // the original rejection.
        navigation.catch(() => undefined);
        if (testCase.replayClick) {
          const viewToggle = page.locator(".panel.workflow:not([hidden]) .panel-view-toggle");
          const dock = page.locator(".dock");
          const workflow = page.locator("#panel-patcher .workflow-body");
          // WebKit can expose the masthead before it finishes parsing the
          // prerendered dock and workflow. Wait for the complete shell, then
          // keep the geometry assertion below as the real visibility check.
          await Promise.all([
            viewToggle.waitFor({ state: "visible" }),
            dock.waitFor({ state: "attached" }),
            workflow.waitFor({ state: "attached" }),
          ]);
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
            const dock = document.querySelector(".dock")?.getBoundingClientRect();
            const links = document.querySelector(".dock-tab")?.getBoundingClientRect();
            const status = [...document.querySelectorAll(".dock-tab")].at(-1)?.getBoundingClientRect();
            const workflow = document.querySelector("#panel-patcher .workflow-body")?.getBoundingClientRect();
            return {
              dockInFirstViewport:
                !!dock &&
                dock.top < window.innerHeight &&
                dock.bottom <= window.innerHeight &&
                !!links &&
                links.bottom <= window.innerHeight &&
                !!status &&
                status.bottom <= window.innerHeight,
              prerendered: root?.hasAttribute("aria-busy") === true,
              dockTop: dock?.top ?? null,
              workflowTop: workflow?.top ?? null,
            };
          });
          initialShellLayout = initialShell;
          if (!hasVisiblePrerenderedShell(initialShell)) {
            throw new Error(`initial shell dock is not visible: ${JSON.stringify(initialShell)}`);
          }
          await viewToggle.click();
          releaseScripts();
        }
        await navigation;
        // Every view has a named nav row, so the current page is always marked;
        // the visible panel is the fallback while the nav is still hydrating.
        await page.waitForFunction((expectedView) => {
          const root = document.getElementById("webapp-root");
          if (root?.hasAttribute("aria-busy")) return false;
          const active = document.querySelector('.side-nav [aria-current="page"]');
          if (active) return active.id === `tab-${expectedView}`;
          return !!document.querySelector(`#panel-${expectedView}:not([hidden])`);
        }, testCase.finalView);
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );

        const result = await page.evaluate((initialLayout) => {
          const audit = window.__romWeaverHydrationAudit;
          const root = document.getElementById("webapp-root");
          const dock = document.querySelector(".dock")?.getBoundingClientRect();
          const workflow = document.querySelector("#panel-patcher .workflow-body")?.getBoundingClientRect();
          const workflowStyle = document.querySelector("#panel-patcher .workflow-body");
          const viewToggle = document.querySelector("#panel-patcher .panel-view-toggle input");
          return {
            detailedViewEnabled: viewToggle?.checked === true,
            finalTheme: document.documentElement.dataset.theme || "",
            finalView:
              document.querySelector('.side-nav [aria-current="page"]')?.id.replace(/^tab-/, "") ||
              document.querySelector('[id^="panel-"]:not([hidden])')?.id.replace(/^panel-/, "") ||
              "",
            initialTheme: audit.initialTheme,
            initialView: audit.initialView,
            runtimeRetained: document.querySelector(".sub-status") === audit.runtime,
            runtimeTexts: audit.runtimeTexts,
            resolverCalls: audit.resolverCalls,
            threadRetained: document.querySelector(".panel-threads-btn") === audit.threads,
            threadTexts: audit.threadTexts,
            shellHandoffStable:
              !initialLayout ||
              (Math.abs((dock?.top ?? 0) - initialLayout.dockTop) <= 0.5 &&
                Math.abs((workflow?.top ?? 0) - initialLayout.workflowTop) <= 0.5),
            shellSettled: root?.dataset.shellSettled === "true",
            panelAnimation: workflowStyle ? getComputedStyle(workflowStyle).animationName : "",
          };
        }, initialShellLayout);
        const problems = [];
        if (!result.threadRetained) problems.push("thread node was replaced");
        if (result.resolverCalls !== 2) problems.push(`shell resolver ran ${result.resolverCalls} times`);
        if (!result.runtimeRetained) problems.push("runtime node was replaced");
        // The chip's label is localized, so this audit owns the count and the
        // word, never their capitalization.
        if (result.threadTexts.length !== 1 || !/3\s*threads/i.test(result.threadTexts[0] ?? ""))
          problems.push(`thread text changed: ${JSON.stringify(result.threadTexts)}`);
        if (result.runtimeTexts.length !== 1)
          problems.push(`runtime text changed: ${JSON.stringify(result.runtimeTexts)}`);
        if (result.initialTheme !== "light" || result.finalTheme !== "light")
          problems.push(`theme changed: ${result.initialTheme} -> ${result.finalTheme}`);
        if (result.initialView !== testCase.initialView || result.finalView !== testCase.finalView)
          problems.push(`view changed unexpectedly: ${result.initialView} -> ${result.finalView}`);
        if (testCase.replayClick && !result.detailedViewEnabled)
          problems.push("prerendered view toggle click was not replayed after hydration");
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

export const collectInternalLinkTargets = (links, baseUrl) => {
  const origin = new URL(baseUrl).origin;
  const targets = new Map();
  for (const link of links) {
    const url = new URL(link.href, baseUrl);
    if (!/^https?:$/.test(url.protocol) || url.origin !== origin) continue;
    url.hash = "";
    const href = url.href;
    const target = targets.get(href) || { href, sources: [] };
    if (link.source && !target.sources.includes(link.source)) target.sources.push(link.source);
    targets.set(href, target);
  }
  return [...targets.values()];
};

export const runLinkAudit = async (createContext, baseUrl) => {
  const context = await createContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const links = [];
  try {
    for (const route of LINK_AUDIT_ROUTES) {
      const pageUrl = new URL(route, baseUrl).href;
      const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
      const status = response?.status() || 0;
      if (status < 200 || status >= 400) throw new Error(`${route || "/"} returned HTTP ${status}`);
      if (route === "docs" || route.startsWith("docs/")) {
        await page.locator(".docs-article h1").waitFor({ state: "attached" });
      } else {
        await page.locator("#webapp-root").waitFor({ state: "attached" });
      }
      await page.locator("#webapp-root:not([aria-busy])").waitFor({ state: "attached" });
      links.push(
        ...(await page.evaluate(
          (source) =>
            [...document.querySelectorAll("a[href]")].map((element) => ({
              href: element.href,
              source,
            })),
          route,
        )),
      );
    }

    const targets = collectInternalLinkTargets(links, baseUrl);
    if (!targets.length) throw new Error("link audit found no same-origin links");
    const pagePaths = new Set(
      LINK_AUDIT_ROUTES.map((route) => {
        const pathname = new URL(route, baseUrl).pathname.replace(/\/+$/, "");
        return pathname || "/";
      }),
    );
    const failures = [];
    await Promise.all(
      targets.map(async ({ href, sources }) => {
        try {
          const pathname = new URL(href).pathname.replace(/\/+$/, "") || "/";
          // Vite's dev fallback returns the app shell with 200 for unknown paths when Accept includes text/html.
          // Known page routes need text/html; asset checks use binary Accept so a missing asset remains 404.
          const accept = pagePaths.has(pathname) ? "text/html" : "application/octet-stream";
          const status = await requestStatus(href, { headers: { Accept: accept } });
          if (status >= 400 || status < 200)
            failures.push(`${href} returned HTTP ${status} (from ${sources.join(", ")})`);
        } catch (error) {
          failures.push(`${href} could not be requested (from ${sources.join(", ")}): ${error?.message || error}`);
        }
      }),
    );
    if (failures.length) throw new Error(`link audit found broken same-origin links:\n- ${failures.join("\n- ")}`);
    process.stdout.write(`PASS link audit (${LINK_AUDIT_ROUTES.length} pages, ${targets.length} links)\n`);
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
  const started = performance.now();
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
  process.stdout.write(`PASS accessibility ${label} (${Math.round(performance.now() - started)}ms)\n`);
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
  // Reduced motion keeps the guided tour's re-reveal scrolls instant. Its
  // smooth `scrollBy` otherwise glides the page while Playwright is hovering
  // the bundle download button, and the hover retries "element is not stable"
  // until it times out. Chromium only: under the emulation WebKit intermittently
  // serves stale theme colours to axe after a theme flip (`.mode-label` read
  // dark-theme text on a light background), so WebKit keeps its default media.
  const context = await createContext({
    ignoreHTTPSErrors: true,
    ...(browserName === "chromium" ? { reducedMotion: "reduce" } : {}),
  });
  const scanGuidedLoading = await createGuidedLoadingAudit(context, scanLiveApp);
  let page = await context.newPage();
  const cssCoverageEntries = [];
  const failures = [];
  // Bind the page this call is watching: `page` is reassigned as the audit moves
  // on, and a failure reported without the document it happened on sends the
  // reader through every navigation in the audit to find it.
  const watchPageErrors = () => {
    const watched = page;
    watched.on("pageerror", (error) => failures.push(`[${watched.url()}] ${error.stack || error.message}`));
  };
  watchPageErrors();
  // Theme is a named menu rather than a cycle, so the choice is picked by its value.
  const setTheme = async (theme) => {
    if ((await page.locator("html").getAttribute("data-theme")) === theme) return;
    await page.locator(".theme-tool:visible").first().click();
    await page.locator(`[role="menuitemradio"][data-theme-choice="${theme}"]:visible`).first().click();
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
  };
  /** A nav row by name, from whichever layout the viewport shows. */
  // Rows are found by tab id, never by label, so a renamed destination keeps its audit.
  const navRow = (id) => page.locator(`.side-nav:visible #tab-${id}, #menu-sheet:visible [data-nav="${id}"]`).first();
  /** Menu is the phone's index; the sidebar is always on screen on desktop. */
  const openNav = async () => {
    if (await page.locator(".side-nav:visible").count()) return;
    if (!(await page.locator("#menu-sheet:visible").count())) await page.locator(".dock-menu").click();
    await page.locator("#menu-sheet:visible").waitFor({ state: "visible" });
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
        // iteration-count 1 matters as much as the zeroed duration: a
        // zero-duration *infinite* animation is degenerate and WebKit can leave
        // the element compositing a mid-keyframe colour, which axe then reads
        // as a contrast failure. One zero-length pass ends deterministically.
        "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;}" +
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
    await page.locator(".not-found-home").waitFor({ state: "visible" });
    await page.locator(".not-found-docs:visible").waitFor({ state: "visible" });
    await installAuditTools();
    await scanVariants("not found");
    if (browserName === "chromium") cssCoverageEntries.push(...(await page.coverage.stopCSSCoverage()));
    await page.close();

    // The host serves 404.html at whatever path missed, so the page's links
    // must resolve against its <base> tag rather than the missed directory.
    page = await context.newPage();
    watchPageErrors();
    const missedUrl = new URL("assets/missing/", baseUrl).href;
    const missedResponse = await page.goto(missedUrl, { waitUntil: "domcontentloaded" });
    if (missedResponse?.status() !== 404) {
      throw new Error(`missed nested path returned ${missedResponse?.status()}, expected 404`);
    }
    await page.locator(".not-found-page").waitFor({ state: "visible" });
    await page.locator("#webapp-root:not([aria-busy])").waitFor({ state: "attached" });
    const notFoundLinks = await page.evaluate(() => ({
      brand: document.querySelector(".brand-mark-link")?.href,
      home: document.querySelector(".not-found-home")?.href,
      word: document.querySelector(".brand-word-link")?.href,
    }));
    for (const [name, href, expected] of [
      ["brand mark", notFoundLinks.brand, baseUrl],
      ["brand word", notFoundLinks.word, baseUrl],
      ["home action", notFoundLinks.home, new URL("apply-patches", baseUrl).href],
    ]) {
      if (href !== expected) throw new Error(`404 page ${name} link at ${missedUrl} is ${href}, expected ${expected}`);
    }
    await page.locator(".brand-mark-link").click();
    await page.locator(".home-page").waitFor({ state: "visible" });
    if (page.url() !== baseUrl) throw new Error(`404 page brand link landed on ${page.url()}, expected ${baseUrl}`);
    await page.close();

    page = await context.newPage();
    watchPageErrors();
    if (browserName === "chromium") await page.coverage.startCSSCoverage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".home-page").waitFor({ state: "visible" });
    if ((await page.locator('.mode[aria-selected="true"]').count()) !== 0) {
      throw new Error("the landing page marks a workflow tab as selected");
    }
    await installAuditTools();
    await scanVariants("landing");

    await page.goto(new URL("apply", baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });

    // On a mobile Docs reload the docs bar is already in the prerendered shell.
    // Its fixed position must be viewport-relative before hydration finishes;
    // WebKit otherwise treats the workflow body's entrance translate as its
    // containing block and leaves the bar below the article.
    await page.setViewportSize(A11Y_VIEWPORTS.find((viewport) => viewport.label === "mobile"));
    // The guide the document already carries must not be fetched again as its
    // HTML chunk: docs-page.tsx adopts the prerendered article
    // (adoptPrerenderedDocsHtml) and the route document deliberately drops that
    // chunk's modulepreload. Both halves are silent when they break - the page
    // still renders, it just downloads the article twice - so watch the wire.
    const guideChunkPattern = /\/assets\/get-started-[^/]*\.js(?:\?.*)?$/;
    // The docs route chunk uses the same `<name>-<hash>.js` shape, so watching
    // for it too keeps the guide assertion from passing vacuously if chunk
    // naming ever changes and the guide pattern stops matching anything.
    const routeChunkPattern = /\/assets\/docs-page-[^/]*\.js(?:\?.*)?$/;
    const guideChunkRequests = [];
    let routeChunkRequests = 0;
    const recordGuideChunkRequest = (request) => {
      if (guideChunkPattern.test(request.url())) guideChunkRequests.push(request.url());
      if (routeChunkPattern.test(request.url())) routeChunkRequests += 1;
    };
    page.on("request", recordGuideChunkRequest);
    const docsReloadResponse = await page.goto(new URL("docs/get-started/", baseUrl).href, { waitUntil: "commit" });
    const docsReloadHtml = (await docsReloadResponse?.text()) ?? "";
    if (!docsReloadHtml.includes('class="warp-rail is-initializing"')) {
      throw new Error("Docs route response is missing the static rail initialization state");
    }
    if (!docsReloadHtml.includes('aria-current="true"')) {
      throw new Error("Docs route response is missing the static initial rail marker");
    }
    if (guideChunkPattern.test(docsReloadHtml)) {
      throw new Error("Docs route document preloads the guide chunk whose article it already carries");
    }
    const docsBar = page.locator(".docs-bar");
    await docsBar.waitFor({ state: "attached" });
    const trailGeometry = await docsBar.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        position: getComputedStyle(element).position,
        viewportHeight: window.innerHeight,
      };
    });
    const bottomGap = trailGeometry.viewportHeight - trailGeometry.bottom;
    if (trailGeometry.position !== "fixed" || bottomGap < -1 || bottomGap > 128 || trailGeometry.height <= 0) {
      throw new Error(`Mobile Docs bar is not fixed to the viewport on reload: ${JSON.stringify(trailGeometry)}`);
    }
    await page.locator(".docs-article h1").waitFor({ state: "visible" });
    await page.locator(".dock").waitFor({ state: "visible" });
    await page.locator(".dock-menu").waitFor({ state: "visible" });
    await page.locator(".dock-app").waitFor({ state: "visible" });
    const docsOpen = page.locator(".docs-bar-open");
    await docsOpen.waitFor({ state: "visible" });
    await docsOpen.click();
    await page.locator("#docs-drawer:visible").waitFor({ state: "visible" });
    await page.locator("#docs-drawer .docs-row.is-here").waitFor({ state: "visible" });
    if (await page.locator("#menu-sheet:visible").count()) throw new Error("Both mobile navigation layers are open");
    // The same button closes the drawer, so it MUST stay above the drawer's scrim.
    await page.locator('.docs-bar-open[aria-expanded="true"]').click();
    await page.locator("#docs-drawer").waitFor({ state: "hidden" });
    page.off("request", recordGuideChunkRequest);
    if (guideChunkRequests.length > 0) {
      throw new Error(`Docs route refetched the article it was served: ${guideChunkRequests.join(", ")}`);
    }
    if (routeChunkRequests === 0) {
      throw new Error("Docs route requested no docs-page chunk; the chunk request watch above proves nothing");
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
      await docsNavigationPage.goto(new URL("apply", baseUrl).href, { waitUntil: "domcontentloaded" });
      await docsNavigationPage.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });
      await docsNavigationPage.route(docsChunkPattern, async (route) => {
        docsChunkRequest();
        await docsChunkReleased;
        await route.continue();
      });
      await docsNavigationPage.locator('.side-nav .nav-row[href="/docs"]:visible').click();
      await docsChunkStarted;
      await docsNavigationPage
        .locator('.side-nav .nav-row[aria-current="page"][id="tab-patcher"]')
        .waitFor({ state: "visible" });
      if ((await docsNavigationPage.locator(".side-nav .guide-nav").count()) !== 0) {
        throw new Error("Docs navigation appeared before its lazy article route loaded");
      }
      releaseDocsChunk();
      await docsNavigationPage.locator(".side-nav .guide-nav").waitFor({ state: "visible" });
      await docsNavigationPage.locator('.side-nav .guide-nav a[aria-current="page"][id="tab-docs"]').waitFor({
        state: "visible",
      });
    } finally {
      await docsNavigationContext.close();
    }
    await page.setViewportSize(A11Y_VIEWPORTS.find((viewport) => viewport.label === "desktop"));
    await page.goto(new URL("apply", baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });
    await installAuditTools();

    for (const viewport of A11Y_VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        await openSettingsPanel(page);
        await scanLiveApp(page, `Settings (${viewport.label}, ${theme})`);
        const betaTools = page.locator("#settings-beta-tools-enabled");
        if (!(await betaTools.isChecked())) await betaTools.check();
        await page.locator(".settings-actions .btn.primary:visible").click();
      }
      for (const tab of ["patcher", "creator"]) {
        await openNav();
        await navRow(tab).click();
        await page.locator(`#panel-${tab}:not([hidden])`).waitFor({ state: "visible" });
        for (const theme of ["light", "dark"]) {
          await setTheme(theme);
          await scanLiveApp(page, `${tab} (${viewport.label}, ${theme})`);
        }
      }
      // Trim, PPF undo and Save Editor are named rows under their own group
      // heading, which is what supplies the noun their short label drops.
      for (const tab of ["trim", "ppf-undo", "save-editor"]) {
        await openNav();
        await navRow(tab).click();
        await page.locator(`#panel-${tab}:not([hidden])`).waitFor({ state: "visible" });
        for (const theme of ["light", "dark"]) {
          await setTheme(theme);
          await scanLiveApp(page, `${tab} (${viewport.label}, ${theme})`);
        }
      }
    }

    await page.setViewportSize(A11Y_VIEWPORTS[0]);
    await setTheme("light");
    await openNav();
    await navRow("patcher").click();

    const infoButton = page.locator(".info-btn").first();
    await infoButton.click();
    await page.locator(".info-pop").waitFor({ state: "visible" });
    await scanVariants("info popover");
    await infoButton.click();

    await openSettingsPanel(page);
    // Codecs are Advanced fields, so the console hides them until the switch is on.
    const advancedSwitch = page.locator('.console-advanced[role="switch"]').first();
    if ((await advancedSwitch.getAttribute("aria-checked")) !== "true") await advancedSwitch.click();
    const codecCombobox = page.locator(".codec-combobox input").first();
    await codecCombobox.click();
    await page.locator(".codec-combobox-list").waitFor({ state: "visible" });
    await scanVariants("codec combobox");
    await page.locator(".codec-combobox-option").first().click();
    await page.locator(".settings-actions .btn.primary:visible").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    await openNav();
    await navRow("logs").click();
    const logDialog = page.locator("dialog.log-dlg");
    await logDialog.waitFor({ state: "visible" });
    await scanVariants("log dialog");
    await logDialog.locator(".console-close:visible, .dlg-x:visible").click();

    await page.locator(".reset-btn:visible").click();
    const resetConfirmation = page.locator(".rw-modal .confirm-card:visible");
    await resetConfirmation.waitFor({ state: "visible" });
    await scanLiveApp(page, "reset confirmation (desktop, light)");
    // Cancel is the ghost action; the primary one would reset the page.
    await resetConfirmation.locator(".c-actions .btn.ghost").click();

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
    const onboardingChip = page.locator(".sample-tutorial-start-chip:visible").first();
    await onboardingChip.waitFor({ state: "visible", timeout: 60_000 });
    await onboardingChip.click();
    const guidedApply = page.locator(".sample-tutorial-start-primary:visible").first();
    await guidedApply.waitFor({ state: "visible", timeout: 60_000 });
    const tutorial = page.locator(".sample-tutorial-dialog");
    // Guided Apply opens on the drop zone and loads nothing until asked, so its
    // first step is scanned waiting for files; Continue then loads the practice
    // files and moves on by itself once they are in.
    await guidedApply.click();
    await page
      .locator('.sample-tutorial-dialog[data-step="1"][data-step-count="4"]:not([data-moving])')
      .waitFor({ state: "visible", timeout: 60_000 });
    await scanVariants("guided Apply 1/4 (waiting for files)");
    await tutorial.locator(".sample-tutorial-next").click();
    for (let step = 2; step <= 4; step += 1) {
      await page
        .locator(`.sample-tutorial-dialog[data-step="${step}"][data-step-count="4"]:not([data-moving])`)
        .waitFor({ state: "visible", timeout: 60_000 });
      await scanVariants(`guided Apply ${step}/4`);
      if (step === 4) {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
          page.locator("#rom-weaver-button-apply").click(),
        ]);
        await download.cancel();
      } else {
        await tutorial.locator(".sample-tutorial-next").click();
      }
    }
    await tutorial.waitFor({ state: "hidden" });
    await page.locator("#rom-weaver-button-apply").waitFor({ state: "visible", timeout: 60_000 });
    await page.locator("#rom-weaver-button-test-emulator").waitFor({ state: "visible", timeout: 60_000 });

    await scanGuidedLoading(page, ["first-weave.zip"], "guided Bundle loading (desktop, light)", async () => {
      await page.goto(new URL("bundle?guide=bundle", baseUrl).href, { waitUntil: "domcontentloaded" });
      await page.locator("#rom-weaver-input-file-unified-bundle").waitFor({ state: "attached" });
      await installAuditTools();
    });
    for (let step = 1; step <= 4; step += 1) {
      await page
        .locator(`.sample-tutorial-dialog[data-step="${step}"][data-step-count="4"]:not([data-moving])`)
        .waitFor({ state: "visible", timeout: 60_000 });
      await scanVariants(`guided Bundle ${step}/4`);
      if (step === 4) {
        const createBundleButton = page.locator("#rom-weaver-button-export-bundle:not([data-downloadable])");
        await createBundleButton.waitFor({ state: "visible", timeout: 60_000 });
        await page.waitForFunction(
          () => {
            const button = document.getElementById("rom-weaver-button-export-bundle");
            return button instanceof HTMLButtonElement && !button.disabled;
          },
          undefined,
          { timeout: 60_000 },
        );
        await createBundleButton.click();
        // The same control turns into the download once the bundle is built.
        const downloadButton = page.locator("#rom-weaver-button-export-bundle[data-downloadable]");
        await downloadButton.waitFor({ state: "visible", timeout: 60_000 });
        // Stability first: the guide re-anchors (and may scroll) while the
        // control settles from Create into Download, and hovering during that
        // motion retries "element is not stable" until it times out. The hover
        // still runs before the click so the :hover lift (translateY) is
        // latched by then and the click does not move the button mid-press.
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
        await tutorial.locator(".sample-tutorial-next").click();
      }
    }
    await tutorial.waitFor({ state: "hidden" });

    await page.setViewportSize(A11Y_VIEWPORTS[0]);
    await setTheme("light");
    const firstPatchMenu = page.locator(".patch-menu-btn:not(.is-editing):visible").first();
    await firstPatchMenu.click();
    await page.locator('.patch-menu-list:not([hidden]) [role="menuitem"][id^="rom-weaver-patch-meta-edit-"]').click();
    const patchDetailsDone = page.locator(".patch-menu-btn.is-editing:visible");
    await patchDetailsDone.waitFor({ state: "visible" });
    await scanVariants("patch details editor");
    await patchDetailsDone.click();

    await page.setViewportSize(A11Y_VIEWPORTS[0]);
    await setTheme("light");
    // Handles are in card order, so the first one is patch 1 of the stack.
    const patchHandles = page.locator("button.phandle:visible");
    await patchHandles.first().focus();
    await patchHandles.first().press("ArrowDown");
    await patchHandles.nth(1).waitFor({ state: "visible" });
    await scanLiveApp(page, "reordered patches (desktop, light)");
    await patchHandles.first().click();
    const patchPositionInput = page.locator("input.phandle-input:visible");
    await patchPositionInput.waitFor({ state: "visible" });
    await scanVariants("patch position editor");
    await patchPositionInput.press("Escape");

    await page.setViewportSize(A11Y_VIEWPORTS[0]);
    await setTheme("light");
    await openNav();
    await navRow("creator").click();
    const createOnboardingChip = page.locator(".sample-tutorial-start-chip:visible").first();
    await createOnboardingChip.waitFor({ state: "visible" });
    await createOnboardingChip.click();
    const guidedCreate = page.locator(".sample-tutorial-start-primary:visible").first();
    await guidedCreate.waitFor({ state: "visible" });
    await scanGuidedLoading(
      page,
      ["hello-world.nes", "modified-world.nes"],
      "guided Create loading (desktop, light)",
      () => guidedCreate.click(),
    );
    for (let step = 1; step <= 6; step += 1) {
      await page
        .locator(`.sample-tutorial-dialog[data-step="${step}"][data-step-count="6"]:not([data-moving])`)
        .waitFor({ state: "visible", timeout: 60_000 });
      await scanVariants(`guided Create ${step}/6`);
      if (step === 6) {
        await page.locator("#patch-builder-button-create").click();
      } else {
        await tutorial.locator(".sample-tutorial-next").click();
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
      await page.goto(`${baseUrl.replace(/\/$/, "")}/${slug}`, { waitUntil: "commit" });
      await page.locator(".docs-article h1").waitFor({ state: "visible" });
      await installAuditTools();
      const headings = await page.locator("h1").count();
      assertSingleDocsHeading(headings, slug);
      // This origin is not production, so once the page is live every sample
      // download has to have moved to it. The served HTML still names
      // production, which is the right answer for a crawler but the wrong one
      // for anyone copying a command out of a beta or preview deployment.
      // Hydration clears aria-busy before the asset-base effect re-renders the
      // article. Wait for that second update before checking the production
      // origin, otherwise WebKit can observe the authored HTML in between.
      await page.waitForFunction((productionOrigin) => {
        if (document.getElementById("webapp-root")?.hasAttribute("aria-busy")) return false;
        const stillProduction = [...document.querySelectorAll(".docs-article pre code")]
          .flatMap((block) => (block.textContent || "").match(/https?:\/\/[^\s"'<>]+/g) || [])
          .some((value) => URL.canParse(value) && new URL(value).origin === productionOrigin);
        return !stillProduction;
      }, SITE_ORIGIN);
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
  } catch (error) {
    const dialog = await page
      .locator(".sample-tutorial-dialog")
      .textContent({ timeout: 1000 })
      .catch(() => "No tutorial dialog");
    process.stderr.write(
      `Accessibility audit failed; tutorial dialog: ${dialog}\nPage errors: ${failures.join("\n")}\n`,
    );
    throw error;
  } finally {
    await context.close();
  }
};

// WebKit keeps the hydration and accessibility passes in separate persistent
// contexts, so they can overlap without sharing the stateful accessibility page.
// Chromium stays serial: its accessibility pass owns the one global CSS-coverage
// union, and preserving the phase order keeps that collection easy to reason about.
export const runAuditPhases = async (runHydration, runAccessibility, parallel) => {
  if (parallel) {
    const results = await Promise.allSettled([runHydration(), runAccessibility()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    return;
  }
  await runHydration();
  await runAccessibility();
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
  await openSettingsPanel(page);
  await page.locator("#settings-default-compression").selectOption("none");
  await page.locator(".settings-actions .btn.primary:visible").click();
};

const buildPpfUndoPatch = (records, undo = true) => {
  const header = Buffer.alloc(60);
  header.write("PPF30", 0, "ascii");
  header[5] = 2;
  header.write("Browser undo journey", 6, "ascii");
  header[58] = Number(undo);
  return Buffer.concat([
    header,
    ...records.map(({ offset, data, original }) => {
      const recordHeader = Buffer.alloc(9);
      recordHeader.writeBigUInt64LE(BigInt(offset));
      recordHeader[8] = data.length;
      return Buffer.concat([recordHeader, Buffer.from(data), ...(undo ? [Buffer.from(original)] : [])]);
    }),
  ]);
};

const buildUndoJourneyZip = (entries) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [fileName, bytes] of entries) {
    const name = Buffer.from(fileName);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const readUndoJourneyZip = (bytes) => {
  const entries = new Map();
  let offset = bytes.readUInt32LE(bytes.length - 6);
  const count = bytes.readUInt16LE(bytes.length - 12);
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("PPF Undo: invalid ZIP directory");
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
    const localOffset = bytes.readUInt32LE(offset + 42);
    const payloadOffset =
      localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const payload = bytes.subarray(payloadOffset, payloadOffset + size);
    const method = bytes.readUInt16LE(offset + 10);
    if (method !== 0 && method !== 8) throw new Error(`PPF Undo: unsupported ZIP fixture method ${method}`);
    entries.set(name, method === 8 ? zlib.inflateRawSync(payload) : payload);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
};

const runPpfUndoJourney = async (createContext, baseUrl) => {
  const context = await createContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const failures = [];
  const downloads = [];
  page.on("pageerror", (error) => failures.push(error.stack || error.message));
  page.on("download", (download) => downloads.push(download));
  const original = Buffer.from("abcdefghijklmnop");
  const patched = Buffer.from("abXY123hijklmnop");
  const records = [
    { offset: 2, data: "XYZW", original: "cdef" },
    { offset: 4, data: "123", original: "ZWg" },
  ];
  const validPatch = buildPpfUndoPatch(records);
  const patchFile = (buffer, name) => ({ buffer, mimeType: "application/octet-stream", name });
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const nav = page.locator("#tab-ppf-undo");
    await nav.waitFor({ state: "visible" });
    if (await nav.locator(".nav-beta").count()) throw new Error("PPF Undo navigation still has a beta chip");
    await nav.click();
    const picker = page.locator("#ppf-undo-input-picker");
    await picker.waitFor({ state: "attached" });
    await picker.setInputFiles([patchFile(patched, "patched.bin"), patchFile(validPatch, "overlapping.ppf")]);
    const restore = page.getByRole("button", { name: "Restore original ROM", exact: true });
    await page.locator("#ppf-undo-output-compression").selectOption("none");
    const restoreAndCheck = async () => {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
        restore.click(),
      ]);
      const downloadPath = await download.path();
      if (!downloadPath) throw new Error("PPF Undo: Playwright did not expose the downloaded file");
      if (!fs.readFileSync(downloadPath).equals(original)) {
        throw new Error("PPF Undo: restored ROM differs from the original bytes");
      }
      if (download.suggestedFilename() !== "patched-restored.bin") {
        throw new Error(`PPF Undo: unexpected output filename ${download.suggestedFilename()}`);
      }
      await page.getByRole("button", { name: "Download patched-restored.bin", exact: true }).waitFor();
    };
    await restoreAndCheck();
    for (const { buffer, name, error } of [
      {
        buffer: buildPpfUndoPatch(records, false),
        name: "no-undo.ppf",
        error: "PPF patch does not contain complete undo data",
      },
      {
        buffer: buildPpfUndoPatch([...records, { offset: original.length, data: "X", original: "a" }]),
        name: "out-of-bounds.ppf",
        error: "PPF undo data exceeds ROM bounds",
      },
    ]) {
      await picker.setInputFiles(patchFile(buffer, name));
      const previousDownloads = downloads.length;
      await restore.click();
      await page.locator("#ppf-undo-container").getByRole("alert").filter({ hasText: error }).waitFor({
        timeout: DOWNLOAD_TIMEOUT_MS,
      });
      await restore.waitFor({ state: "visible" });
      if (downloads.length !== previousDownloads) throw new Error(`PPF Undo: ${name} triggered a download`);
      if (await page.getByRole("button", { name: "Download patched-restored.bin", exact: true }).count()) {
        throw new Error(`PPF Undo: ${name} left a downloadable output`);
      }
      await picker.setInputFiles(patchFile(validPatch, "overlapping.ppf"));
      await page.locator("#ppf-undo-container").getByRole("alert").waitFor({ state: "hidden" });
      await restoreAndCheck();
    }
    if (downloads.length !== 3) throw new Error(`PPF Undo: expected 3 downloads, got ${downloads.length}`);
    await picker.setInputFiles(
      patchFile(
        buildUndoJourneyZip([
          ["patched.bin", patched],
          ["overlapping.ppf", validPatch],
          ["ignored.ips", Buffer.from("PATCHEOF")],
        ]),
        "undo-inputs.zip",
      ),
    );
    await page.locator("#ppf-undo-container").getByRole("status").filter({ hasText: "Ignored ignored.ips" }).waitFor();
    await restoreAndCheck();
    await page.locator("#ppf-undo-output-compression").selectOption("zip");
    const [compressed] = await Promise.all([
      page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
      restore.click(),
    ]);
    const compressedPath = await compressed.path();
    if (
      !(
        compressedPath &&
        [...readUndoJourneyZip(fs.readFileSync(compressedPath)).values()].some((bytes) => bytes.equals(original))
      )
    ) {
      throw new Error("PPF Undo: ZIP output did not contain the original ROM bytes");
    }
    if (compressed.suggestedFilename() !== "patched-restored.zip")
      throw new Error("PPF Undo: unexpected ZIP output name");
    await picker.setInputFiles(patchFile(Buffer.from("PATCHEOF"), "unsupported.ips"));
    await page.locator("#ppf-undo-container").getByRole("alert").filter({ hasText: "No valid PPF patch" }).waitFor();
    if (!(await restore.isDisabled())) throw new Error("PPF Undo: unsupported patch left the prior patch runnable");
    await picker.setInputFiles(patchFile(validPatch, "replacement.ppf"));
    await page.locator("#ppf-undo-container").getByRole("alert").waitFor({ state: "hidden" });
    await page.locator("#ppf-undo-output-compression").selectOption("none");
    await restoreAndCheck();
    const originalDisc = Buffer.alloc(2352 * 16);
    original.copy(originalDisc);
    const patchedDisc = Buffer.from(originalDisc);
    patched.copy(patchedDisc);
    const cue = Buffer.from('FILE "track.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
    const restoreDiscAndCheck = async () => {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
        restore.click(),
      ]);
      const downloadPath = await download.path();
      if (!downloadPath) throw new Error("PPF Undo: missing disc download");
      const entries = readUndoJourneyZip(fs.readFileSync(downloadPath));
      if (
        !(
          entries.get("track.bin")?.equals(originalDisc) &&
          [...entries.entries()].some(([name, bytes]) => name.endsWith(".cue") && bytes.equals(cue))
        )
      ) {
        throw new Error("PPF Undo: disc download did not preserve the restored track and sheet");
      }
    };
    await picker.setInputFiles(
      patchFile(
        buildUndoJourneyZip([
          ["disc.cue", cue],
          ["track.bin", patchedDisc],
          ["extra.bin", Buffer.from("extra")],
          ["disc.ppf", validPatch],
          ["alternative.ppf", validPatch],
        ]),
        "disc.zip",
      ),
    );
    const selection = page.locator(".rw-modal.select-modal .seltree");
    await selection.getByRole("button").filter({ hasText: "track.bin" }).click();
    await selection.getByRole("button").filter({ hasText: "disc.ppf" }).click();
    await page
      .locator("#ppf-undo-container")
      .getByRole("status")
      .filter({ hasText: "Choose one patched ROM" })
      .waitFor();
    await restoreDiscAndCheck();
    await picker.setInputFiles([
      patchFile(cue, "disc.cue"),
      patchFile(patchedDisc, "track.bin"),
      patchFile(validPatch, "disc.ppf"),
    ]);
    await restoreDiscAndCheck();
    if (failures.length) throw new Error(`PPF Undo: uncaught page error\n${failures.join("\n")}`);
    process.stdout.write("PASS PPF Undo (overlapping records, validation errors, replacement recovery)\n");
  } finally {
    await context.close();
  }
};

const runApplyJourney = async (createContext, baseUrl, name, fixtureNames) => {
  const context = await createContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.stack || error.message));
  try {
    await page.goto(new URL("apply", baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });
    await configureUncompressedOutput(page);
    await page
      .locator("#rom-weaver-input-file-unified")
      .setInputFiles(fixtureNames.map((fixture) => path.join(FIXTURE_DIR, fixture)));

    const apply = page.locator("#rom-weaver-button-apply");
    await apply.waitFor({ state: "visible" });
    // Require the Apply action as well as enabledness before starting the run.
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
  const browser = await browserType.launch({
    headless: true,
    ...systemChromeLaunchOptions,
  });
  return {
    browser,
    createContext: (options) => browser.newContext(createContextOptions(options)),
    persistentContextDirs,
  };
};

const startServer = (mode, port, corpusDir) => {
  const server = childProcess.spawn(process.execPath, ["scripts/dev-server.mjs", mode, "--port", String(port)], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, PORT: String(port), ...(corpusDir ? { ROM_WEAVER_E2E_CORPUS_DIR: corpusDir } : {}) },
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
    RUN_ARCHIVE_JOURNEY && browserName === "chromium" && !process.env.ROM_WEAVER_E2E_CORPUS_DIR
      ? createWorkerReuseCorpus()
      : null;
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
    const scenario = (name, run) =>
      runE2EScenario(name, async () => {
        const { browser, createContext, persistentContextDirs } = await createBrowserContextFactory(
          browserType,
          browserName,
        );
        try {
          await run(createContext);
        } finally {
          await browser?.close();
          for (const userDataDir of persistentContextDirs) fs.rmSync(userDataDir, { force: true, recursive: true });
        }
      });
    if (RUN_AUDITS) {
      await runAuditPhases(
        () => scenario("hydration", (createContext) => runHydrationAudit(createContext, previewBaseUrl)),
        () => scenario("accessibility", (createContext) => runAccessibilityAudit(createContext, previewBaseUrl)),
        browserName === "webkit",
      );
    }
    if (RUN_LINK_AUDIT) await scenario("links", (createContext) => runLinkAudit(createContext, devBaseUrl));
    if (RUN_RAW_JOURNEY) {
      await scenario("PPF Undo/download/recovery", (createContext) => runPpfUndoJourney(createContext, previewBaseUrl));
      await scenario("raw apply/download", (createContext) =>
        runApplyJourney(createContext, previewBaseUrl, "raw apply/download", [
          "archive_sources/game.bin",
          "archive_sources/change.ips",
        ]),
      );
    }
    if (RUN_ARCHIVE_JOURNEY) {
      await scenario("archive routing/apply/download", (createContext) =>
        runApplyJourney(createContext, previewBaseUrl, "archive routing/apply/download", [
          "archives/one-rom.zip",
          "archives/one-patch.7z",
        ]),
      );
      // The stress page MUST use the dev server because it is not a production entry point.
      if (browserName === "chromium" && corpusDir) {
        await scenario("archive worker reuse", (createContext) => runArchiveStressSmoke(createContext, devBaseUrl));
      }
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

export const runE2EScenario = async (name, run, report = (line) => process.stdout.write(`${line}\n`)) => {
  for (let attempt = 1; attempt <= E2E_ATTEMPTS; attempt += 1) {
    const started = performance.now();
    let status = "failed";
    try {
      await run();
      status = "passed";
      return;
    } catch (error) {
      const message = error?.message || String(error);
      // Assertions and locator timeouts MUST fail immediately; replaying them hides deterministic regressions.
      const infrastructureFailure =
        /browser has been closed|browser.*disconnected|Target crashed|ECONNRESET|ECONNREFUSED|net::ERR_CONNECTION_(?:RESET|CLOSED)/i.test(
          message,
        );
      report(`FAIL ${name} attempt=${attempt}: ${error?.stack || message}`);
      if (attempt === E2E_ATTEMPTS || !infrastructureFailure) throw error;
      report(`RETRY ${name} with a fresh browser`);
    } finally {
      report(
        `TIMING ${name} attempt=${attempt} status=${status} durationMs=${Math.round(performance.now() - started)}`,
      );
    }
  }
};

const run = async () => {
  const build = resolveE2EBuild(process.env);
  if (build.source === "prebuilt") {
    assertPrebuiltWebappDist((file) => fs.readFileSync(path.join(PACKAGE_DIR, "dist", file), "utf8"));
  } else {
    childProcess.execFileSync("npm", ["run", "build"], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, ROM_WEAVER_CHANNEL: build.channel },
      stdio: "inherit",
    });
  }
  await main();
};

// Guards direct execution (`node scripts/run-webapp-e2e.mjs`, or via the
// `test:e2e:webapp*`/`test:e2e:a11y` npm scripts) from module import - the
// unit tests in run-webapp-e2e.test.mjs import this file for its exported
// pure helpers and must not trigger a full browser E2E run as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error?.stack || String(error)}\n`);
    process.exitCode = 1;
  });
}
