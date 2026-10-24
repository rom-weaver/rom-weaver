import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ConfirmDialog } from "../../src/public/react/components/ds/modal.tsx";
import { LogDialog } from "../../src/webapp/components/log-dialog.tsx";
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

afterEach(() => root?.unmount());

const settings = () => page.getByRole("dialog", { name: "Settings", exact: true });
const confirmation = () => page.getByRole("dialog", { name: "Discard settings changes?", exact: true });

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
