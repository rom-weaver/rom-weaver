import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { preloadCatalog } from "../../src/presentation/localization/index.ts";
import { ConfirmDialog } from "../../src/public/react/components/ds/modal.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { LogDialog } from "../../src/webapp/components/log-dialog.tsx";
import { getDefaultSettings } from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import { createEmptyValidationState } from "../../src/webapp/webapp-state-types.ts";
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";

let root;

const SettingsHarness = () => {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const close = () => (dirty ? setConfirm(true) : setOpen(false));
  return createElement(
    "div",
    { className: "rw-app" },
    createElement("button", { onClick: () => setOpen(true), type: "button" }, "Open Settings"),
    open
      ? createElement(LogDialog, {
          initialTab: "settings",
          onClose: close,
          onLevelChange: () => undefined,
          open,
          settingsPanel: createElement("input", {
            "aria-label": "Detailed information",
            checked: dirty,
            onChange: (event) => setDirty(event.target.checked),
            type: "checkbox",
          }),
        })
      : null,
    createElement(ConfirmDialog, {
      body: "Your saved settings will be kept.",
      cancelLabel: "Keep editing",
      confirmLabel: "Discard changes",
      onCancel: () => setConfirm(false),
      onConfirm: () => {
        setConfirm(false);
        setDirty(false);
        setOpen(false);
      },
      open: confirm,
      title: "Discard settings changes?",
    }),
  );
};

beforeEach(() => {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  root = createRoot(host);
  root.render(createElement(SettingsHarness));
});

afterEach(async () => {
  root?.unmount();
  await page.viewport(1280, 900);
});

const settings = () => page.getByRole("dialog", { name: "Settings", exact: true });
const confirmation = () => page.getByRole("dialog", { name: "Discard settings changes?", exact: true });

const SettingsPanelHarness = ({ language = "en" }) => {
  const [draftSettings, setDraftSettings] = useState(() => ({ ...getDefaultSettings(), language }));
  return createElement(
    "div",
    { className: "rw-app" },
    createElement(
      RomWeaverSettingsProvider,
      { settings: draftSettings },
      createElement(LogDialog, {
        initialTab: "settings",
        onClose: () => undefined,
        onLevelChange: () => undefined,
        open: true,
        settingsPanel: createElement(SettingsPanel, {
          draftSettings,
          onDraftChange: (field, value) => setDraftSettings((draft) => ({ ...draft, [field]: value })),
          validation: createEmptyValidationState(),
        }),
      }),
    ),
  );
};

test("Settings help is hit-testable inside the native modal", async () => {
  root.render(createElement(SettingsPanelHarness));
  const input = page.getByRole("checkbox", { name: "Store emulator saves on this device", exact: true });
  await expect.element(input).toBeVisible();
  const trigger = page.getByRole("button", { name: "About Store emulator saves on this device", exact: true });
  await trigger.click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  const panel = document.getElementById(trigger.element().getAttribute("aria-controls"));
  expect.soft(document.querySelector("dialog:modal").contains(panel)).toBe(true);
  await expect.element(page.elementLocator(panel)).toBeVisible();
  await expect
    .poll(() => {
      const rect = panel.getBoundingClientRect();
      return [0.1, 0.5, 0.9].every((fraction) =>
        panel.contains(document.elementFromPoint(rect.left + rect.width * fraction, rect.top + rect.height / 2)),
      );
    })
    .toBe(true);
  await trigger.click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  expect(document.getElementById(panel.id)).toBeNull();
});

for (const width of [320, 1280]) {
  for (const language of ["en", "de", "es"]) {
    test(`Settings toggle targets do not overlap adjacent help at ${width}px in ${language}`, async () => {
      await page.viewport(width, 900);
      await preloadCatalog(language);
      root.render(createElement(SettingsPanelHarness, { language }));
      await expect.poll(() => document.querySelector(".setchecks label.popt.opt")).not.toBeNull();
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      );
      const labels = [...document.querySelectorAll(".setchecks label.popt.opt")];
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        label.scrollIntoView({ block: "center" });
        const rect = label.getBoundingClientRect();
        expect.soft(rect.height, label.textContent).toBeGreaterThanOrEqual(44);
        const input = label.querySelector("input");
        expect(input.getBoundingClientRect().width).toBe(38);
        expect(input.getBoundingClientRect().height).toBe(22);
        const trigger = label.parentElement.querySelector(".info-btn");
        if (!trigger) continue;
        const hit = document.elementFromPoint(rect.right - 2, rect.top + rect.height / 2);
        expect.soft(label.contains(hit), label.textContent).toBe(true);
        const checked = input.checked;
        await page.elementLocator(label).click({ position: { x: rect.width - 2, y: rect.height / 2 } });
        await expect.poll(() => input.checked).toBe(!checked);
        await expect.element(page.elementLocator(trigger)).toHaveAttribute("aria-expanded", "false");
      }
    });
  }
}

for (const method of ["Close", "Escape"]) {
  test(`dirty Settings ${method} keeps its confirmation interactive in the native top layer`, async () => {
    const opener = page.getByRole("button", { name: "Open Settings", exact: true });
    await opener.click();
    await page.getByRole("checkbox", { name: "Detailed information" }).click();
    const close = settings().getByRole("button", { name: "Close", exact: true });
    if (method === "Close") await close.click();
    else await userEvent.keyboard("{Escape}");

    await expect.element(confirmation()).toBeVisible();
    const native = document.querySelector("dialog:modal");
    const overlay = document.querySelector(".rw-modal");
    expect(native.contains(overlay), "confirmation must share the native dialog's top layer").toBe(true);
    expect(native.inert).toBe(false);
    await expect.poll(() => overlay.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Tab}");
    await expect.element(confirmation().getByRole("button", { name: "Keep editing" })).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(confirmation().getByRole("button", { name: "Discard changes" })).toHaveFocus();

    await confirmation().getByRole("button", { name: "Keep editing" }).click();
    await expect.element(confirmation()).not.toBeInTheDocument();
    await expect.element(settings()).toBeVisible();
    await expect.element(page.getByRole("checkbox", { name: "Detailed information" })).toBeChecked();
    await expect.poll(() => native.contains(document.activeElement)).toBe(true);
    expect(native.querySelector(".dlg-frame").inert).toBe(false);

    await close.click();
    await expect.element(confirmation()).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(confirmation()).not.toBeInTheDocument();
    await expect.element(settings()).toBeVisible();
    await expect.element(close).toHaveFocus();

    await close.click();
    await confirmation().getByRole("button", { name: "Discard changes" }).click();
    await expect.element(settings()).not.toBeInTheDocument();
    await expect.element(opener).toHaveFocus();
    await opener.click();
    await expect.element(page.getByRole("checkbox", { name: "Detailed information" })).not.toBeChecked();
  });
}
