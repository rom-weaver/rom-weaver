// Playwright helpers that drive the real Apply route (apply-rom-patches). Everything goes through
// the page's own DOM; OPFS and wasm stay inside the app's dedicated workers.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { WEBAPP_DIR } from "./server.mjs";

const require = createRequire(path.join(WEBAPP_DIR, "package.json"));
export const { chromium } = require("playwright");

const UNIFIED_INPUT = "#rom-weaver-input-file-unified";

export async function newSession(
  browser,
  baseUrl,
  { route = "apply-rom-patches", acceptDownloads = true, ready = UNIFIED_INPUT } = {},
) {
  const context = await browser.newContext({
    acceptDownloads,
    ignoreHTTPSErrors: true,
    viewport: { height: 1100, width: 1280 },
  });
  const page = await context.newPage();
  const session = { consoleErrors: [], context, page, pageErrors: [] };
  page.on("pageerror", (error) => session.pageErrors.push(error.message));
  page.on("console", (message) => {
    // The preview server's self-signed certificate makes service-worker script fetches fail; that is
    // an environment artifact, not an app defect.
    const text = message.text();
    if (message.type() === "error" && !/SSL certificate error|fetching the script|ERR_CERT/i.test(text))
      session.consoleErrors.push(text.slice(0, 400));
  });
  const url = new URL(route, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
  await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" });
  await page.locator(ready).waitFor({ state: "attached", timeout: 60_000 });
  await page.waitForTimeout(1500);
  return session;
}

/** Stage files via the unified drop input. Each entry is a path or { name, buffer }. */
export async function stage(page, files) {
  // Playwright forbids mixing paths and buffers, so everything goes through buffers.
  const payload = files.map((file) =>
    typeof file === "string"
      ? {
          buffer: fs.readFileSync(file),
          mimeType: "application/octet-stream",
          name: path.basename(file),
        }
      : { buffer: Buffer.from(file.buffer), mimeType: "application/octet-stream", name: file.name },
  );
  await page.locator(UNIFIED_INPUT).setInputFiles(payload);
}

/** Snapshot the visible state of the apply form for assertions and failure messages. */
export async function snapshot(page) {
  return page.evaluate(() => {
    const visible = (element) => element.getClientRects().length > 0;
    const cards = Array.from(document.querySelectorAll("main .card.file"))
      .filter(visible)
      .map((card) => ({
        classes: Array.from(card.classList),
        text: card.innerText.replace(/\s+/g, " ").trim().slice(0, 300),
      }));
    const notices = Array.from(document.querySelectorAll("[id$='-message'], .notice, [role='alert']"))
      .filter(visible)
      .map((element) => ({
        id: element.id,
        level: element.className,
        text: element.innerText.replace(/\s+/g, " ").trim().slice(0, 400),
      }))
      .filter((notice) => notice.text);
    const apply = document.getElementById("rom-weaver-button-apply");
    const nameInput = document.getElementById("rom-weaver-input-output-file-name");
    const formatSelect = document.getElementById("rom-weaver-select-output-format");
    return {
      applyDisabled:
        apply instanceof HTMLButtonElement ? apply.disabled || apply.getAttribute("aria-disabled") === "true" : null,
      blockedReason:
        document.getElementById("rom-weaver-apply-blocked-reason")?.innerText.replace(/\s+/g, " ").trim() ?? null,
      applyText: apply?.innerText.replace(/\s+/g, " ").trim() ?? null,
      cards,
      formatOptions: formatSelect
        ? Array.from(formatSelect.options).map((option) => ({
            disabled: option.disabled,
            label: option.textContent,
            value: option.value,
          }))
        : [],
      formatValue: formatSelect?.value ?? null,
      notices,
      outputName: nameInput?.value ?? null,
    };
  });
}

/** Error-level notices already on screen (for example a staging failure). */
export const errorNotices = (state) => state.notices.filter((notice) => /error|danger|bad/i.test(String(notice.level)));

/**
 * Wait until no card has a stage bar and every patch card shows a verdict (or all cards, with no patch).
 * Cards that never get a verdict (for example formats without checks) count as settled once the DOM has
 * been stable with no stage bar for ~3 s.
 */
export async function waitSettled(page, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let lastSignature = "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("main .card.file")).filter(
        (card) => card.getClientRects().length > 0,
      );
      const patches = cards.filter((card) => card.classList.contains("patch"));
      const verdict = (card) => ["ok", "bad", "warn", "error"].some((name) => card.classList.contains(name));
      return {
        busy: cards.some((card) => card.classList.contains("has-stage-bar")),
        count: cards.length,
        done: cards.length > 0 && (patches.length ? patches : cards).every(verdict),
        signature: cards.map((card) => card.className + card.innerText.length).join("|"),
      };
    });
    if (state.count > 0 && !state.busy && state.done) return;
    if (state.signature !== lastSignature || state.busy) {
      lastSignature = state.signature;
      stableSince = Date.now();
    } else if (state.count > 0 && Date.now() - stableSince > 3000) return;
    await page.waitForTimeout(400);
  }
  throw new Error("staged inputs never settled");
}

export async function waitApplyEnabled(page, timeout = 90_000) {
  await page.waitForFunction(
    () => {
      const control = document.getElementById("rom-weaver-button-apply");
      return (
        control instanceof HTMLButtonElement && !control.disabled && control.getAttribute("aria-disabled") !== "true"
      );
    },
    undefined,
    { timeout },
  );
}

/**
 * Click the primary action and resolve with the outcome: the downloaded bytes, or the first error
 * notice the app shows. Never throws for app-level failures; throws only on harness timeouts.
 */
export async function runApply(page, outDir, { timeout = 180_000 } = {}) {
  const button = page.locator("#rom-weaver-button-apply");
  const downloadPromise = page.waitForEvent("download", { timeout }).then(
    async (download) => {
      const saved = path.join(outDir, `${Date.now()}-${download.suggestedFilename()}`);
      await download.saveAs(saved);
      return {
        bytes: fs.readFileSync(saved),
        kind: "download",
        name: download.suggestedFilename(),
        saved,
      };
    },
    () => null,
  );
  const errorPromise = page
    .waitForFunction(
      () => {
        const notice = Array.from(
          document.querySelectorAll("[id$='-message'], [role='alert'], .notice.error, .notice.bad"),
        ).find(
          (element) =>
            element.getClientRects().length > 0 &&
            element.innerText.trim() &&
            (/error|bad|danger/i.test(String(element.className)) ||
              /error|fail|could not|cannot|invalid|unable|unsupported|mismatch|no rom/i.test(element.innerText)),
        );
        return notice ? notice.innerText.replace(/\s+/g, " ").trim().slice(0, 500) : null;
      },
      undefined,
      { polling: 250, timeout },
    )
    .then(async (handle) => ({ kind: "error", text: await handle.jsonValue() }))
    .catch(() => null);
  await button.click();
  const outcome = await Promise.race([
    downloadPromise.then((value) => value && value),
    errorPromise.then((value) => value),
  ]);
  return outcome ?? { kind: "timeout" };
}
