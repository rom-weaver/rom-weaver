import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { getDefaultSettings, getSettingsUiState } from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";
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
  host.className = "rw-app";
  document.body.replaceChildren(host);
});

afterEach(async () => {
  await expect.poll(() => document.documentElement.classList.contains("vt-theme")).toBe(false);
  root?.unmount();
  root = null;
  host?.remove();
});

const themeButton = (choice) => document.querySelector(`#settings-theme [data-theme-choice="${choice}"]`);

test("theme preference lives in Settings as a three-icon toggle", async () => {
  mountSettings();

  await expect.poll(() => document.querySelector("#settings-theme")).not.toBeNull();
  const buttons = [...document.querySelectorAll("#settings-theme .seg-btn")];
  expect(buttons.map((button) => button.dataset.themeChoice)).toEqual(["light", "dark", "auto"]);
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Light", "Dark", "Match system"]);
  expect(themeButton("auto").querySelector(".theme-auto-badge")).not.toBeNull();

  themeButton("auto").click();
  await expect.poll(() => localStorage.getItem("rom-weaver-theme")).toBe("auto");
  await expect.poll(() => themeButton("auto").getAttribute("aria-pressed")).toBe("true");

  themeButton("dark").click();
  await expect.poll(() => document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem("rom-weaver-theme")).toBe("dark");
  await expect.poll(() => themeButton("dark").getAttribute("aria-pressed")).toBe("true");
  expect(themeButton("auto").getAttribute("aria-pressed")).toBe("false");
});

test("Settings reveals the theme from its toggle with a native snapshot", async () => {
  mountSettings();
  await expect.poll(() => document.querySelector("#settings-theme")).not.toBeNull();
  const preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  const button = themeButton(preference);
  const rect = button.getBoundingClientRect();
  button.click();
  const findAnimation = () =>
    document.getAnimations().find((animation) => animation.effect?.pseudoElement === "::view-transition-new(root)");
  await expect.poll(findAnimation).toBeTruthy();
  const animation = findAnimation();
  animation.pause();
  try {
    expect(document.documentElement.dataset.theme).toBe(preference);
    expect(localStorage.getItem("rom-weaver-theme")).toBe(preference);
    const origin = animation.effect.getKeyframes()[0].clipPath.match(/at ([\d.]+)% ([\d.]+)%/);
    expect((Number(origin[1]) / 100) * window.innerWidth).toBeCloseTo(rect.left + rect.width / 2, 1);
    expect((Number(origin[2]) / 100) * window.innerHeight).toBeCloseTo(rect.top + rect.height / 2, 1);
  } finally {
    animation.finish();
    await animation.finished;
  }
});
