import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { getDefaultBrowserThreadCount, getDefaultThreadCount } from "../../src/platform/shared/compression-options.ts";
import { getDefaultSettings, getSettingsUiState } from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import { createEmptyValidationState } from "../../src/webapp/webapp-state-types.ts";

let mountedRoot = null;
let rootElement = null;

beforeEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  rootElement = document.createElement("div");
  document.body.replaceChildren(rootElement);
});

afterEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  document.body.replaceChildren();
});

const mountSettingsPanel = () => {
  const draftSettings = getDefaultSettings();
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(
    createElement(SettingsPanel, {
      draftSettings,
      onDraftChange: () => undefined,
      uiState: getSettingsUiState(draftSettings),
      validation: createEmptyValidationState(),
    }),
  );
};

test("browser auto thread default uses hardware concurrency with a four thread floor", () => {
  expect(getDefaultThreadCount({ navigator: { hardwareConcurrency: 2 } })).toBe(4);
  expect(getDefaultThreadCount({ navigator: { hardwareConcurrency: 12 } })).toBe(12);
  expect(getDefaultThreadCount({ navigator: { hardwareConcurrency: undefined } })).toBe(4);
});

test("browser auto thread default still falls back to one when threaded wasm is unavailable", () => {
  expect(getDefaultBrowserThreadCount({ crossOriginIsolated: true, navigator: { hardwareConcurrency: 12 } })).toBe(12);
  expect(getDefaultBrowserThreadCount({ crossOriginIsolated: false, navigator: { hardwareConcurrency: 12 } })).toBe(1);
});

test("worker thread settings placeholder keeps auto and shows the resolved count", async () => {
  mountSettingsPanel();

  await expect
    .element(page.getByRole("textbox", { name: "Threads" }))
    .toHaveAttribute("placeholder", `auto (${getDefaultBrowserThreadCount()})`);
});

test("language selection lives in Settings", async () => {
  mountSettingsPanel();

  await expect.element(page.getByRole("combobox", { name: "Language" })).toHaveValue("en");
});
