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

const collectPageState = async (page) =>
  page.evaluate(async () => {
    const response = await fetch(location.href, { cache: "no-store", credentials: "same-origin" });
    return {
      controller: Boolean(navigator.serviceWorker?.controller),
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      headers: {
        crossOriginEmbedderPolicy: response.headers.get("Cross-Origin-Embedder-Policy"),
        crossOriginOpenerPolicy: response.headers.get("Cross-Origin-Opener-Policy"),
        crossOriginResourcePolicy: response.headers.get("Cross-Origin-Resource-Policy"),
      },
      serviceWorkerState: window.ROM_WEAVER_SERVICE_WORKER?.getState?.() || null,
      title: document.title,
    };
  });

const waitForControlledPage = async (page) => {
  await page.waitForFunction(() => navigator.serviceWorker?.controller, undefined, { timeout: PAGE_TIMEOUT_MS });
  await page.waitForFunction(() => globalThis.crossOriginIsolated === true, undefined, { timeout: PAGE_TIMEOUT_MS });
};

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
  const requestFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
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

  await page.goto(ROOT_URL, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT_MS });

  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker?.controller)))) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: PAGE_TIMEOUT_MS }).catch(() => undefined),
      page.evaluate(() => window.ROM_WEAVER_SERVICE_WORKER?.forceCacheAndReload?.()).catch(() => undefined),
    ]);
  }

  await waitForControlledPage(page);
  await page.waitForLoadState("networkidle", { timeout: PAGE_TIMEOUT_MS }).catch(() => undefined);
  await wait(250);
  if (requestFailures.length > 0) {
    throw new Error(`Controlled page had failed requests: ${JSON.stringify(requestFailures, null, 2)}`);
  }
  const controlledState = await collectPageState(page);

  await stopPreview(previewProcess);
  previewProcess = null;
  await wait(250);
  const offlineResponse = await page.reload({ waitUntil: "networkidle", timeout: PAGE_TIMEOUT_MS });
  const offlineState = await collectPageState(page);

  if (requestFailures.length > 0) {
    throw new Error(`Offline reload had failed requests: ${JSON.stringify(requestFailures, null, 2)}`);
  }
  if (offlineResponse?.status() !== 200) throw new Error(`Offline reload returned ${offlineResponse?.status()}`);
  if (!(offlineState.controller && offlineState.crossOriginIsolated)) {
    throw new Error(`Offline reload was not controlled and isolated: ${JSON.stringify(offlineState)}`);
  }

  console.log(
    JSON.stringify(
      {
        consoleErrors,
        controlledState,
        offlineReload: {
          status: offlineResponse.status(),
          state: offlineState,
        },
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
