import { expect } from "playwright/test";

// macOS WebKit MUST use Option+Tab to include links with the default keyboard preferences.
// https://bugs.webkit.org/show_bug.cgi?id=161394
const tabKey = process.platform === "darwin" && process.env.ROM_WEAVER_BROWSER === "webkit" ? "Alt+Tab" : "Tab";

// Keyboard journeys MUST reach controls through the tab order, without locator.focus().
export const tabTo = async (page, target) => {
  await target.waitFor({ state: "attached" });
  for (let step = 0; step < 100; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(tabKey);
  }
  throw new Error(
    `Keyboard could not reach ${target} within 100 Tab presses\n${await page.locator("body").ariaSnapshot()}`,
  );
};

export const chooseFilesByKeyboard = async (page, input, files) => {
  // Interception MUST start before traversal, or native activation can race its subscription.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    (async () => {
      await tabTo(page, input);
      await page.keyboard.press("Enter");
    })(),
  ]);
  expect(chooser.isMultiple(), "The keyboard file picker must accept ROMs and patches together").toBe(true);
  await chooser.setFiles(files);
};

const expectFocusInside = async (dialog) => {
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
};

const auditDialogKeyboard = async (page, trigger, dialog) => {
  await tabTo(page, trigger);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expectFocusInside(dialog);
  // Reverse traversal from the initial dialog focus exercises the end of the tab order.
  for (const key of [`Shift+${tabKey}`, tabKey, tabKey, `Shift+${tabKey}`]) {
    await page.keyboard.press(key);
    // Native dialogs MAY yield focus to browser chrome, but never to background page controls.
    await expect
      .poll(() =>
        dialog.evaluate(
          (element) =>
            element.contains(document.activeElement) ||
            (element.matches(":modal") && !document.hasFocus() && document.activeElement === document.body),
        ),
      )
      .toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/#console-/);
  await expect(trigger).toBeFocused();
};

export const runAccessibleNavigationAudit = async (createContext, baseUrl) => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    const context = await createContext({
      ignoreHTTPSErrors: true,
      locale: "en-US",
      reducedMotion: "reduce",
      viewport,
    });
    const page = await context.newPage();
    try {
      await page.goto(new URL("apply", baseUrl).href, { waitUntil: "domcontentloaded" });
      await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached" });
      await page.locator("#webapp-root:not([aria-busy])").waitFor({ state: "attached" });
      const main = page.getByRole("main");
      await expect(main).toHaveCount(1);
      const skip = page.getByRole("link", { name: "Skip to main content", exact: true });
      await page.keyboard.press(tabKey);
      await expect(skip).toBeFocused();
      const workflowUrl = new URL(page.url());
      await page.keyboard.press("Enter");
      await expect(main).toBeFocused();
      expect(new URL(page.url()).pathname).toBe(workflowUrl.pathname);

      const settings = page.locator(".shell-head-tools .settings-tool:visible, .topbar-tools .settings-tool:visible");
      const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
      await auditDialogKeyboard(page, settings, settingsDialog);
      await page.keyboard.press("Enter");
      await expect(settingsDialog).toBeVisible();
      await expect.poll(() => settingsDialog.ariaSnapshot()).toMatch(/- heading "Settings" \[level=2\]/);
      await expect(settingsDialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(1);
      await tabTo(page, settingsDialog.getByRole("button", { name: "Save", exact: true }));
      await page.keyboard.press("Enter");
      await expect(settingsDialog).toBeHidden();
      await expect(page).not.toHaveURL(/#console-/);
      await expect(settings).toBeFocused();

      const reset = page.getByRole("button", { name: "Reset", exact: true });
      const confirmation = page.getByRole("dialog", { name: "Reset the page?", exact: true });
      await auditDialogKeyboard(page, reset, confirmation);
      await page.keyboard.press("Enter");
      await expect(confirmation).toBeVisible();
      const snapshot = await confirmation.ariaSnapshot();
      expect(snapshot).toMatch(/- dialog "Reset the page\?"/);
      expect(snapshot).toMatch(/- button "Stay here"/);
      const cancel = confirmation.getByRole("button", { name: "Stay here", exact: true });
      await tabTo(page, cancel);
      await page.keyboard.press("Enter");
      await expect(confirmation).toBeHidden();
      await expect(reset).toBeFocused();

      const input = page.locator("#rom-weaver-input-file-unified");
      await expect(input).toHaveAccessibleName("Drop or click to add ROMs, patches, weaves, or archives");
      await chooseFilesByKeyboard(page, input, []);
      process.stdout.write(
        `PASS accessible navigation (${viewport.width}px: skip link, dialog names/focus, keyboard file picker)\n`,
      );
    } finally {
      await context.close();
    }
  }
};
