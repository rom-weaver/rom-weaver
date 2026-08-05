#!/usr/bin/env node

import { spawn } from "node:child_process";
import https from "node:https";
import process from "node:process";
import { chromium } from "playwright";

const ROOT_URL = process.env.ROM_WEAVER_VERIFY_URL || "https://localhost:4173/";
const PORT = new URL(ROOT_URL).port || "4173";
// `npm run preview` includes the production WASM + Vite build gate. A clean CI
// runner can spend minutes there before the preview server prints its URL.
const STARTUP_TIMEOUT_MS = Number(process.env.ROM_WEAVER_VERIFY_STARTUP_TIMEOUT_MS || 300000);
const PAGE_TIMEOUT_MS = 20000;
const OFFLINE_PAGES = [
  { expectedView: "patcher", label: "apex", path: "" },
  { expectedView: "patcher", label: "apply slashless", path: "apply.html" },
  { expectedView: "patcher", label: "apply directory", path: "apply/" },
  { expectedView: "patcher", label: "apply directory document", path: "apply/index.html" },
  { expectedView: "creator", label: "create slashless", path: "create.html" },
  { expectedView: "creator", label: "create directory", path: "create/" },
  { expectedView: "creator", label: "create directory document", path: "create/index.html" },
  { expectedView: "trim", label: "trim directory", path: "trim/" },
  { expectedView: "trim", label: "trim directory document", path: "trim/index.html" },
  // Tools has no rail/dock tab since it moved into the More menu (#427), so its
  // readiness is asserted through the visible tabpanel instead of a selected tab.
  { expectedView: "tools", label: "tools directory", path: "tools/", tabless: true },
  { expectedView: "tools", label: "tools directory document", path: "tools/index.html", tabless: true },
  { expectedView: "test", label: "test directory", path: "test/" },
  { expectedView: "test", label: "test directory document", path: "test/index.html" },
  { expectedNotFound: true, label: "not found", path: "404.html" },
];
const OFFLINE_ONLY_PAGES = [{ expectedNotFound: true, label: "unknown first offline visit", path: "not-a-real-route" }];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The preview server uses a self-signed certificate, so loopback requests must skip
// verification. Anything that is not loopback keeps full TLS validation - a redirected or
// misconfigured URL should fail loudly rather than silently trust an unknown certificate.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const shouldRejectUnauthorized = (url) => {
  try {
    return !LOOPBACK_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return true;
  }
};

const requestHeaders = (url) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "HEAD",
        rejectUnauthorized: shouldRejectUnauthorized(url),
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.headers));
      },
    );
    request.on("error", reject);
    request.end();
  });

const readIsolationHeaders = (headers) => ({
  crossOriginEmbedderPolicy: headers["cross-origin-embedder-policy"] || null,
  crossOriginOpenerPolicy: headers["cross-origin-opener-policy"] || null,
  crossOriginResourcePolicy: headers["cross-origin-resource-policy"] || null,
});

const signalPreview = (child, signal) => {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
};

const startPreview = () =>
  new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "preview", "--", "--port", PORT, "--no-coop-coep"], {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      signalPreview(child, "SIGINT");
      reject(new Error(`Preview did not start within ${STARTUP_TIMEOUT_MS}ms.\n${output}`));
    }, STARTUP_TIMEOUT_MS);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(ROOT_URL)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Preview exited before verification started; code=${code}.\n${output}`));
    });
  });

const stopPreview = (child) =>
  new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    signalPreview(child, "SIGINT");
    setTimeout(() => {
      if (child.exitCode === null) signalPreview(child, "SIGTERM");
    }, 2000);
  });

const waitForPreviewOffline = async () => {
  const deadline = Date.now() + 10000;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    try {
      await requestHeaders(ROOT_URL);
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) return;
    }
    await wait(100);
  }
  throw new Error(`Preview origin still answered requests after shutdown: ${ROOT_URL}`);
};

const collectPageState = async (page, { probeHeaders = true } = {}) =>
  page.evaluate(async (shouldProbeHeaders) => {
    const response = shouldProbeHeaders
      ? await fetch(location.href, { cache: "no-store", credentials: "same-origin" }).catch(() => null)
      : null;
    const root = document.getElementById("webapp-root");
    return {
      activePanel: document.querySelector('section[role="tabpanel"]:not([hidden])')?.id || null,
      activeView:
        document.querySelector('[role="tab"][aria-selected="true"][data-mode]')?.getAttribute("data-mode") || null,
      controller: Boolean(navigator.serviceWorker?.controller),
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      headers: {
        crossOriginEmbedderPolicy: response?.headers.get("Cross-Origin-Embedder-Policy") || null,
        crossOriginOpenerPolicy: response?.headers.get("Cross-Origin-Opener-Policy") || null,
        crossOriginResourcePolicy: response?.headers.get("Cross-Origin-Resource-Policy") || null,
      },
      notFound: document.documentElement.dataset.page === "not-found",
      ready: Boolean(root && !root.hasAttribute("aria-busy")),
      serviceWorkerState: window.ROM_WEAVER_SERVICE_WORKER?.getState?.() || null,
      title: document.title,
    };
  }, probeHeaders);

const waitForControlledPage = async (page) => {
  await page.waitForFunction(() => navigator.serviceWorker?.controller, undefined, { timeout: PAGE_TIMEOUT_MS });
  await page.waitForFunction(() => globalThis.crossOriginIsolated === true, undefined, { timeout: PAGE_TIMEOUT_MS });
};

const waitForPageReady = async (page, pageCase) => {
  try {
    await waitForPageReadyInner(page, pageCase);
  } catch (error) {
    const state = await collectPageState(page, { probeHeaders: false }).catch(() => null);
    throw new Error(
      `Page never became ready: ${pageCase.label} (${pageCase.path || "/"}): ${error.message}\nstate: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
};

const waitForPageReadyInner = async (page, pageCase) => {
  await page.waitForFunction(
    ({ expectedNotFound, expectedView, tabless }) => {
      const root = document.getElementById("webapp-root");
      if (!root || root.hasAttribute("aria-busy")) return false;
      if (expectedNotFound) return document.documentElement.dataset.page === "not-found";
      const panel = document.getElementById(`panel-${expectedView}`);
      return (
        (tabless || document.querySelector(`[role="tab"][aria-selected="true"][data-mode="${expectedView}"]`)) &&
        panel &&
        !panel.hasAttribute("hidden") &&
        Boolean(panel.querySelector(".workflow-body")?.textContent?.trim())
      );
    },
    pageCase,
    { timeout: PAGE_TIMEOUT_MS },
  );
};

const enableBetaToolsForRouteChecks = async (page) => {
  await page.evaluate(() => {
    const key = "rom-weaver-settings";
    const stored = JSON.parse(localStorage.getItem(key) || "{}");
    localStorage.setItem(
      key,
      JSON.stringify({
        ...stored,
        common: { ...stored.common, betaToolsEnabled: true },
        // Must match SETTINGS_STORAGE_VERSION (src/webapp/settings/settings-schema.ts);
        // a mismatch makes the app wipe these settings and re-gate the beta routes.
        version: 6,
      }),
    );
  });
};

const assertPageState = (pageCase, response, state, phase) => {
  if (response?.status() !== 200) throw new Error(`${phase} ${pageCase.label} returned ${response?.status()}`);
  const pageReady = state.controller && state.crossOriginIsolated && state.ready;
  if (!pageReady || state.serviceWorkerState?.serviceWorkerStatus !== "active") {
    throw new Error(`${phase} ${pageCase.label} was not controlled, isolated, and ready: ${JSON.stringify(state)}`);
  }
  if (Boolean(pageCase.expectedNotFound) !== state.notFound) {
    throw new Error(`${phase} ${pageCase.label} had the wrong not-found state: ${JSON.stringify(state)}`);
  }
  if (pageCase.expectedNotFound) return;
  if (pageCase.tabless) {
    if (state.activePanel !== `panel-${pageCase.expectedView}`) {
      throw new Error(
        `${phase} ${pageCase.label} showed ${state.activePanel}, expected panel-${pageCase.expectedView}`,
      );
    }
    return;
  }
  if (state.activeView !== pageCase.expectedView) {
    throw new Error(`${phase} ${pageCase.label} selected ${state.activeView}, expected ${pageCase.expectedView}`);
  }
};

const summarizePageState = (state) => ({
  activeView: state.activeView,
  controller: state.controller,
  crossOriginIsolated: state.crossOriginIsolated,
  notFound: state.notFound,
  ready: state.ready,
  serviceWorkerStatus: state.serviceWorkerState?.serviceWorkerStatus || null,
});

let previewProcess;
let browser;

try {
  previewProcess = await startPreview();
  const originHeaders = readIsolationHeaders(await requestHeaders(ROOT_URL));
  if (
    originHeaders.crossOriginEmbedderPolicy ||
    originHeaders.crossOriginOpenerPolicy ||
    originHeaders.crossOriginResourcePolicy
  ) {
    throw new Error(`Expected preview origin to omit COOP/COEP/CORP headers; got ${JSON.stringify(originHeaders)}`);
  }

  browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "allow" });
  const page = await context.newPage();
  const consoleErrors = [];
  const serviceWorkerLogs = [];
  const httpErrors = [];
  const requestFailures = [];
  page.on("console", (message) => {
    if (message.text().includes("[rom-weaver-sw]")) serviceWorkerLogs.push(message.text());
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push({
        resourceType: response.request().resourceType(),
        status: response.status(),
        url: response.url(),
      });
    }
  });
  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText || "unknown request failure";
    if (request.isNavigationRequest() && error === "net::ERR_ABORTED") return;
    requestFailures.push({
      error,
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
    });
  });

  const initialResponse = await page.goto(ROOT_URL, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT_MS });

  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker?.controller)))) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: PAGE_TIMEOUT_MS }).catch(() => undefined),
      page.evaluate(() => window.ROM_WEAVER_SERVICE_WORKER?.forceCacheAndReload?.()).catch(() => undefined),
    ]);
  }

  await waitForControlledPage(page);
  await page.waitForLoadState("networkidle", { timeout: PAGE_TIMEOUT_MS }).catch(() => undefined);
  await wait(250);
  if (httpErrors.length > 0) {
    throw new Error(`Controlled page had HTTP errors: ${JSON.stringify(httpErrors, null, 2)}`);
  }
  if (requestFailures.length > 0) {
    throw new Error(`Controlled page had failed requests: ${JSON.stringify(requestFailures, null, 2)}`);
  }

  const onlinePages = [];
  for (const [index, pageCase] of OFFLINE_PAGES.entries()) {
    let response = initialResponse;
    if (index === 0) {
      await waitForPageReady(page, pageCase);
    } else {
      response = await page.goto(new URL(pageCase.path, ROOT_URL).href, {
        timeout: PAGE_TIMEOUT_MS,
        waitUntil: "networkidle",
      });
      await waitForControlledPage(page);
      await waitForPageReady(page, pageCase);
    }
    const state = await collectPageState(page);
    assertPageState(pageCase, response, state, "Online");
    onlinePages.push({ path: pageCase.path || "/", state: summarizePageState(state) });
    if (index === 0) await enableBetaToolsForRouteChecks(page);
  }

  await stopPreview(previewProcess);
  previewProcess = null;
  await waitForPreviewOffline();
  await context.setOffline(true);

  const offlinePages = [];
  for (const pageCase of [...OFFLINE_PAGES, ...OFFLINE_ONLY_PAGES]) {
    const failuresBefore = requestFailures.length;
    const httpErrorsBefore = httpErrors.length;
    const offlineResponse = await page.goto(new URL(pageCase.path, ROOT_URL).href, {
      timeout: PAGE_TIMEOUT_MS,
      waitUntil: "networkidle",
    });
    try {
      await waitForPageReady(page, pageCase);
    } catch (error) {
      const state = await collectPageState(page, { probeHeaders: false }).catch(() => null);
      const responseHtml = await offlineResponse
        ?.text()
        .then((html) => html.slice(0, 120))
        .catch(() => "");
      const cacheKeys = await page
        .evaluate(async () =>
          (
            await Promise.all(
              (
                await caches.keys()
              ).map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)),
            )
          )
            .flat()
            .filter((url) => url.includes("not-a-real-route") || url.includes("404.html")),
        )
        .catch(() => []);
      throw new Error(
        `Offline ${pageCase.label} did not become ready: ${JSON.stringify(state)}\nResponse: ${JSON.stringify(responseHtml)}\nCache keys: ${JSON.stringify(cacheKeys)}\n${error instanceof Error ? error.message : String(error)}\n${serviceWorkerLogs.slice(-12).join("\n")}`,
      );
    }
    const offlineState = await collectPageState(page, { probeHeaders: false });
    assertPageState(pageCase, offlineResponse, offlineState, "Offline");
    const routeFailures = requestFailures.slice(failuresBefore);
    if (routeFailures.length > 0) {
      throw new Error(`Offline ${pageCase.label} had failed requests: ${JSON.stringify(routeFailures, null, 2)}`);
    }
    const routeHttpErrors = httpErrors.slice(httpErrorsBefore);
    if (routeHttpErrors.length > 0) {
      throw new Error(`Offline ${pageCase.label} had HTTP errors: ${JSON.stringify(routeHttpErrors, null, 2)}`);
    }
    offlinePages.push({ path: pageCase.path || "/", state: summarizePageState(offlineState) });
  }

  if (consoleErrors.length > 0) {
    throw new Error(`Service-worker page matrix had console errors: ${JSON.stringify(consoleErrors, null, 2)}`);
  }

  console.log(
    JSON.stringify(
      {
        consoleErrors,
        httpErrors,
        offlinePages,
        onlinePages,
        originHeaders,
        requestFailures,
      },
      null,
      2,
    ),
  );
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (previewProcess) await stopPreview(previewProcess);
}
