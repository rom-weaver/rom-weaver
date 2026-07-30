import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { getDefaultSettings, getSettingsUiState } from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import { createEmptyValidationState } from "../../src/webapp/webapp-state-types.ts";

let host;
let root;

const mountSettings = () => {
  const draftSettings = getDefaultSettings();
  root = createRoot(host);
  root.render(
    createElement(
      RomWeaverSettingsProvider,
      { settings: draftSettings },
      createElement(SettingsPanel, {
        draftSettings,
        onDraftChange: () => undefined,
        uiState: getSettingsUiState(draftSettings),
        validation: createEmptyValidationState(),
      }),
    ),
  );
};

beforeEach(() => {
  localStorage.removeItem("rom-weaver-theme");
  host = document.createElement("div");
  document.body.replaceChildren(host);
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
});

test("theme preference lives in Settings as a dropdown", async () => {
  mountSettings();

  await expect.poll(() => document.querySelector("#settings-theme")).not.toBeNull();
  const select = document.querySelector("#settings-theme");
  expect([...select.options].map((option) => option.value)).toEqual(["auto", "light", "dark"]);

  select.value = "auto";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.poll(() => localStorage.getItem("rom-weaver-theme")).toBe("auto");

  select.value = "dark";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.poll(() => document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem("rom-weaver-theme")).toBe("dark");
});
