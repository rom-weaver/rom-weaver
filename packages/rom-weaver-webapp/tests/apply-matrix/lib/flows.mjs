// UI flows shared by the Create / Trim / Compress / Extract groups (the Apply flows live in scenario.mjs).
import { newSession, runApply, stage } from "./ui.mjs";

export const LEVELS = ["min", "very-low", "low", "medium", "high", "very-high", "max"];

/** Click every collapsed "Options" disclosure so codec / level controls become visible. */
export async function openOptions(page) {
  for (const toggle of await page.getByText("Options", { exact: true }).all()) {
    await toggle.click({ timeout: 1500 }).catch(() => undefined);
  }
  await page.waitForTimeout(300);
}

export const optionsOf = (page, selector) =>
  page.evaluate(
    (sel) =>
      Array.from(document.querySelector(sel)?.options || []).map((option) => ({
        disabled: option.disabled,
        label: option.textContent,
        value: option.value,
      })),
    selector,
  );

export async function setSelect(page, selector, value) {
  const available = await optionsOf(page, selector);
  if (!available.some((option) => option.value === value)) return false;
  await page.selectOption(selector, value);
  await page.waitForTimeout(400);
  return true;
}

export async function setLevel(page, value) {
  const select = page.getByLabel("Compression level", { exact: true });
  if (!(await select.count())) return false;
  await select.selectOption(value);
  await page.waitForTimeout(250);
  return true;
}

export async function setCodec(page, codec) {
  const combo = page.getByRole("combobox", { name: /codec/i }).first();
  if (!(await combo.count())) return false;
  await combo.click();
  const option = page.locator("[role=option]", { hasText: new RegExp(`^${codec}$`) }).first();
  if (!(await option.count())) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
  await option.click();
  await page.waitForTimeout(250);
  return true;
}

export async function codecOptions(page) {
  const combo = page.getByRole("combobox", { name: /codec/i }).first();
  if (!(await combo.count())) return [];
  await combo.click();
  await page.waitForTimeout(200);
  const labels = await page.locator("[role=option]").allInnerTexts();
  await page.keyboard.press("Escape").catch(() => undefined);
  return labels.map((label) => label.trim()).filter(Boolean);
}

export async function waitEnabled(page, selector, timeout = 60_000) {
  await page.waitForFunction(
    (sel) => {
      const control = document.querySelector(sel);
      return (
        control instanceof HTMLButtonElement &&
        !control.disabled &&
        control.getAttribute("aria-disabled") !== "true" &&
        !document.querySelector("main .card.file.has-stage-bar")
      );
    },
    selector,
    { timeout },
  );
}

/** Visible text of the whole main region, for failure messages. */
export const mainText = (page) =>
  page
    .locator("main")
    .innerText()
    .then((text) => text.replace(/\s+/g, " ").trim().slice(0, 600))
    .catch(() => "");

/** Visible error notices (any element whose id ends with -message or role=alert with text). */
export const visibleErrors = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[id$='-message'], [role='alert'], .notice.error, .notice.bad"))
      .filter((element) => element.getClientRects().length > 0 && element.innerText.trim())
      .map((element) => element.innerText.replace(/\s+/g, " ").trim().slice(0, 300)),
  );

/** Open /create-rom-patch, stage original + modified, wait until Create is enabled (or blocked). */
export async function openCreate(h, original, modified, { device = null } = {}) {
  const session = await newSession(h.browser, h.baseUrl, {
    device,
    ready: "#patch-builder-input-file-unified",
    route: "create-rom-patch",
  });
  const { page } = session;
  await stage(page, [original, modified].filter(Boolean), "#patch-builder-input-file-unified");
  let enabled = true;
  try {
    await waitEnabled(page, "#patch-builder-button-create", 60_000);
  } catch {
    enabled = false;
  }
  // Hashing / extraction labels keep the page busy after the button first enables.
  await page
    .waitForFunction(
      () => !/Extracting|Checksumming|Reading|Identifying/i.test(document.querySelector("main")?.innerText || ""),
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(800);
  return { enabled, page, session };
}

const CREATE_BUTTON = "#patch-builder-button-create";
export const TRIM_BUTTON = "#trim-builder-button-run";

/** Click the Create button and collect the download or the error. */
export const runCreate = (page, outDir, timeout = 120_000) =>
  runApply(page, outDir, { buttonSelector: CREATE_BUTTON, timeout });

/** Trim shows a confirmation dialog ("Trim this ROM?") before it runs. */
export async function runTrim(page, outDir, { timeout = 180_000, confirm = true } = {}) {
  const resultPromise = runApply(page, outDir, { buttonSelector: TRIM_BUTTON, timeout });
  if (confirm) {
    const dialog = page.locator(".rw-modal[role=dialog], [role=dialog]").first();
    try {
      await dialog.waitFor({ state: "visible", timeout: 15_000 });
      const button = dialog.getByRole("button", { name: /^trim rom$/i }).first();
      if (await button.count()) await button.click();
      else await dialog.getByRole("button").last().click();
    } catch {
      // No dialog: the run may have started directly; the race below still resolves.
    }
  }
  return resultPromise;
}
