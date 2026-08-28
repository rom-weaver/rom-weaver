import { createElement, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { getDefaultBrowserThreadCount } from "../../src/platform/shared/compression-options.ts";
import { createEmptyPageUpdateState } from "../../src/webapp/page-update-state.ts";
import { getDefaultSettings } from "../../src/webapp/settings/settings-state.ts";
import { WebappRoot } from "../../src/webapp/webapp-root.tsx";
import { createEmptyConfirmationDialogState } from "../../src/webapp/webapp-root-types.ts";
import "../../src/webapp/design-system/index.css";
// deferred.css ships lazily in production (webapp.ts loads it at boot); the dialog and
// drawer surfaces under test live in it.
import "../../src/webapp/design-system/deferred.css";
import {
  createEmptyCreatorSessionState,
  createEmptyPatcherSessionState,
  createEmptyValidationState,
} from "../../src/webapp/webapp-state-types.ts";

const POSIX_DIRECTORY_PREFIX_REGEX = /^.*\//;
const MULTI_ROM_ZIP = "tests/fixtures/archives/multi-rom.zip";
const ONE_ROM_ZIP = "tests/fixtures/archives/one-rom.zip";
const CRC32_TEXT_REGEX = /^[0-9a-f]{8}$/i;

const fileNameFromPath = (filePath) => filePath.replace(POSIX_DIRECTORY_PREFIX_REGEX, "");

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  const bytes = await response.arrayBuffer();
  return new File([bytes], fileNameFromPath(filePath), { type });
};

const waitForState = async (resolveState, timeout = 60000, intervalMs = 50) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = resolveState();
    if (state) return state;
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
  return null;
};

const selectCandidateIfPrompted = async (label) => {
  const selectionState = await waitForState(() => {
    const selectedLabel = document.querySelector("#rom-weaver-list-input-stack")?.textContent || "";
    if (selectedLabel.includes(label)) return "selected";
    if (document.querySelector(".rw-modal.select-modal .seltree")) return "dialog";
    return null;
  });
  expect(selectionState).not.toBeNull();
  if (selectionState === "selected") return;
  // An ambiguous multi-entry archive renders as a multi-select checklist: tick the requested entry's
  // checkbox and confirm. A genuinely single-select prompt renders a clickable tree option instead.
  const checklistRow = Array.from(document.querySelectorAll(".rw-modal.select-modal .seltree .selcheck")).find(
    (entry) => entry.textContent?.includes(label),
  );
  if (checklistRow) {
    const checkbox = checklistRow.querySelector("input[type='checkbox']");
    if (checkbox && !checkbox.checked) checkbox.click();
    document.querySelector(".rw-modal.select-modal .selconfirm")?.click();
    return;
  }
  await page.getByRole("button", { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).click();
};

const waitForInputStackFile = async (fileName) => {
  const selected = await waitForState(() => {
    const stackText = document.querySelector("#rom-weaver-list-input-stack")?.textContent || "";
    return stackText.includes(fileName) ? true : null;
  });
  expect(selected).toBe(true);
};

const createNoopActions = () => ({
  onCancelConfirmation: () => undefined,
  onCloseSettings: () => undefined,
  onConfirmConfirmation: () => undefined,
  onCreatorModifiedChange: () => undefined,
  onCreatorOriginalChange: () => undefined,
  onCreatorPatchTypeChange: () => undefined,
  onCreatorSettingsChange: () => undefined,
  onDraftChange: () => undefined,
  onOpenSettings: () => undefined,
  onPatcherInputsChange: () => undefined,
  onPatcherPatchesChange: () => undefined,
  onPatcherSettingsChange: () => undefined,
  onReloadUpdate: () => undefined,
  onReset: () => undefined,
  onRestoreDefaults: () => undefined,
  onSaveClose: () => undefined,
  onSelectView: () => undefined,
  onPpfUndoSessionChange: () => undefined,
});

const createServiceWorkerCacheState = () => ({
  label: "Offline cache unavailable",
  serviceWorkerStatus: null,
  title: "",
  updateLabel: "Reload to update",
  updateReady: false,
  updateTitle: "",
});

const createWebappState = (settings = getDefaultSettings(), currentView = "patcher") => ({
  creatorSession: createEmptyCreatorSessionState(),
  currentView,
  draftSettings: settings,
  patcherSession: createEmptyPatcherSessionState(),
  settings,
  settingsDialogOpen: false,
  startup: {
    message: "",
    status: "ready",
  },
  validation: createEmptyValidationState(),
});

function WebappRootHarness({ initialView = "patcher", settings } = {}) {
  const [currentView, setCurrentView] = useState(initialView);
  const props = useMemo(
    () => ({
      actions: { ...createNoopActions(), onSelectView: setCurrentView },
      confirmationDialog: createEmptyConfirmationDialogState(),
      pageUpdate: createEmptyPageUpdateState(),
      serviceWorkerCache: createServiceWorkerCacheState(),
      state: createWebappState(settings, currentView),
    }),
    [currentView, settings],
  );
  return createElement(WebappRoot, props);
}

let mountedRoot = null;
let rootElement = null;

const mountWebappRoot = (options = {}) => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  const root = createRoot(rootElement);
  root.render(createElement(WebappRootHarness, options));
  mountedRoot = root;
};

beforeEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  rootElement = document.createElement("div");
  rootElement.id = "webapp-root";
  rootElement.setAttribute("aria-busy", "true");
  document.body.replaceChildren(rootElement);
});

test("WebappRoot mounts the full workflow shell and stages archive inputs", async () => {
  // Trim is beta-gated (see `betaToolsEnabled`), so the full-shell assertions
  // below require the flag on - matching the pattern the sibling controller unit tests use.
  mountWebappRoot({ settings: { ...getDefaultSettings(), betaToolsEnabled: true } });

  // The unified drop surface is the only input now; its label flips once the workflow has files.
  const romInput = page.getByLabelText(/ROMs, patches, bundles, or archives/i);

  await expect.element(romInput).toBeInTheDocument();

  await expect.element(page.getByRole("tablist", { name: "Workflow" })).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: /apply/i })).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: /create/i })).toBeInTheDocument();
  await page.getByRole("button", { name: "More" }).click();
  await expect.element(page.getByRole("menuitem", { name: "PPF undo" })).toBeInTheDocument();
  await page.getByRole("button", { name: "More" }).click();

  await romInput.upload(await loadFixtureFile(ONE_ROM_ZIP, "application/zip"));
  await selectCandidateIfPrompted("game.bin");

  await waitForInputStackFile("game.bin");
  await expect.element(page.getByText(CRC32_TEXT_REGEX)).toBeInTheDocument();
  // The output section (and its apply button) renders once the workflow has files.
  await expect.element(page.getByRole("button", { name: /apply & download/i })).toBeInTheDocument();

  await page.getByRole("button", { name: "Clear ROM input" }).click();
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-input-stack")?.textContent || "")
    .not.toContain("game.bin");

  await page
    .getByLabelText(/ROMs, patches, bundles, or archives/i)
    .upload(await loadFixtureFile(MULTI_ROM_ZIP, "application/zip"));

  await selectCandidateIfPrompted("game.bin");

  await waitForInputStackFile("game.bin");
  await expect.element(page.getByText(CRC32_TEXT_REGEX)).toBeInTheDocument();
});

test("WebappRoot keeps Trim gated and PPF undo behind More", async () => {
  mountWebappRoot();
  // Docs is reference rather than a workflow, but it rides in the rail so the
  // readers it is written for do not have to go hunting for it.
  await expect
    .poll(() =>
      [...document.querySelectorAll('.mode-rail [role="tab"]')]
        .filter((tab) => getComputedStyle(tab).display !== "none")
        .map((tab) => tab.textContent),
    )
    .toEqual(["Apply", "Create", "Docs", "Test"]);
  await page.getByRole("button", { name: "More" }).click();
  await expect.element(page.getByRole("menuitem", { name: "PPF undo" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitem", { name: "Identify" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitem", { name: "Docs" })).not.toBeInTheDocument();
});

const dropOnPage = async (fileName) => {
  const transfer = new DataTransfer();
  transfer.items.add(new File([new Uint8Array([1, 2, 3, 4])], fileName));
  document.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
};

/* Regression: Identify used to exist twice - once at /identify and once inside
   the old Tools page - so one page drop reached two forms and both wrote the
   same activity-store key. PPF undo mounts no IdentifyForm at all. */
test("only one Identify workflow ever consumes a page drop", async () => {
  await page.viewport(1280, 900);
  mountWebappRoot({ initialView: "identify", settings: { ...getDefaultSettings(), betaToolsEnabled: true } });
  await expect.poll(() => document.querySelectorAll("#identify-input-picker").length).toBe(1);

  await dropOnPage("first.gba");
  await expect.poll(() => document.querySelector("#identify-container")?.textContent).toContain("first.gba");

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "PPF undo" }).click();
  await expect.poll(() => document.querySelector("#panel-ppf-undo")?.hidden).toBe(false);
  // The Identify panel stays mounted behind PPF undo, so the count also proves the
  // hidden instance is the SAME one, not a second form.
  expect(document.querySelectorAll("#identify-input-picker")).toHaveLength(1);

  await dropOnPage("second.ppf");
  await expect.poll(() => document.querySelector("#identify-container")?.textContent).not.toContain("second.ppf");
  expect(document.querySelector("#identify-container")?.textContent).toContain("first.gba");
});

test("enabled PPF undo and Identify stay behind More on desktop and phone", async () => {
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    await page.viewport(width, height);
    mountWebappRoot({ initialView: "identify", settings: { ...getDefaultSettings(), betaToolsEnabled: true } });
    await expect.element(page.getByRole("button", { name: "More" })).toBeInTheDocument();
    await page.getByRole("button", { name: "More" }).click();
    await expect.element(page.getByRole("menuitem", { name: "PPF undo" })).toBeInTheDocument();
    // Identify is one click from More: it has its own route, so it never hid
    // behind the old Tools page.
    await expect.element(page.getByRole("menuitem", { name: "Identify" })).toBeInTheDocument();
    await page.getByRole("menuitem", { name: "PPF undo" }).click();
    // Only ONE Identify form can exist. PPF undo links nowhere near it, so a page
    // drop has exactly one consumer and the two cannot fight over the activity key.
    expect(document.querySelectorAll("#identify-input-picker")).toHaveLength(1);
    expect(document.querySelector("#ppf-undo-identify-input-picker")).toBeNull();
    await page.getByRole("button", { name: "More" }).click();
    expect(document.querySelector(`[role="tab"][data-mode="ppf-undo"]`)).toBeNull();
    expect(document.querySelector(`[role="tab"][data-mode="identify"]`)).toBeNull();
    expect(document.querySelector(`.dock-tab[data-mode="identify"]`)).toBeNull();
    expect(document.querySelector(`.dock-tab[data-mode="ppf-undo"]`)).toBeNull();
    expect(getComputedStyle(document.querySelector(".panel-settings-btn")).display).not.toBe("none");
    if (width >= 1000) {
      expect(getComputedStyle(document.querySelector(".masthead-settings .tool-text")).display).toBe("none");
      expect(document.querySelector(".masthead-settings .tip")?.textContent).toBe("Settings");
      // More sits in the nav now, so it is named like the tabs beside it rather
      // than tooltipped like the actions cluster it left. The label is a flex
      // item inside `.mode-more`, so its computed display blockifies - that it
      // is not `none` is the assertion, alongside the missing tooltip.
      const moreLabel = document.querySelector(".mode-more .tool-text");
      expect(getComputedStyle(moreLabel).display).not.toBe("none");
      expect(moreLabel.textContent).toBe("More");
      expect(document.querySelector(".mode-more .tip")).toBeNull();
      await page.getByRole("button", { name: "Settings" }).first().hover();
      await expect.poll(() => getComputedStyle(document.querySelector(".masthead-settings .tip")).opacity).toBe("1");
    }
    await expect.element(page.getByRole("menuitem", { name: "Docs" })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "More" }).click();
  }
  await page.viewport(1280, 900);
});

test("WebappRoot reports the configured thread count in the masthead, not the core count", async () => {
  // The masthead thread count must follow the Threads setting. It once called
  // resolveThreads() with no argument, so it always fell through to
  // navigator.hardwareConcurrency and a user who dialled threads down to 1
  // still read the host core count in the header.
  mountWebappRoot({ settings: { ...getDefaultSettings(), threads: 1 } });
  await expect.poll(() => document.querySelector(".masthead-threads")?.textContent || "").toContain("1 Threads");
  await expect
    .poll(() => document.querySelector(".masthead-threads")?.getAttribute("aria-label") || "")
    .toContain("1 threads");
});

test("the runtime status keeps its glyph everywhere and sheds its words when the line is tight", async () => {
  // The glyph is the signal that always survives; the words are what yields -
  // through the compact rail band, on phones, and whenever a channel badge is
  // present (this build carries one, so the words are gone at every width).
  await page.viewport(1280, 900);
  mountWebappRoot({ settings: { ...getDefaultSettings(), threads: 10 } });
  await expect.poll(() => document.querySelector(".sub-status")?.getAttribute("aria-label") || "").not.toBe("");
  expect(document.querySelector(".brand-sub-row .sub-status")).toBeNull();
  expect(document.querySelector(".masthead-tools .sub-status")).toBeTruthy();
  expect(document.querySelector(".masthead-status-text")).toBeNull();
  for (const [width, height] of [
    [1280, 900],
    [1100, 900],
    [390, 844],
  ]) {
    await page.viewport(width, height);
    await expect.poll(() => getComputedStyle(document.querySelector(".sub-status svg")).display).not.toBe("none");
    if (width >= 1160) {
      const titleSize = Number.parseFloat(getComputedStyle(document.querySelector(".brand-word")).fontSize);
      const subtitleSize = Number.parseFloat(getComputedStyle(document.querySelector(".brand-sub-row")).fontSize);
      expect(titleSize).toBeGreaterThan(subtitleSize * 1.8);
      expect(
        Number.parseFloat(getComputedStyle(document.querySelector(".brand-sub-row .build-tag .sub-chip")).fontSize),
      ).toBeLessThanOrEqual(subtitleSize);
      expect(getComputedStyle(document.querySelector(".sub-status svg")).width).toBe("16px");
      expect(getComputedStyle(document.querySelector(".sub-status")).cursor).toBe("pointer");
    }
  }
  await page.viewport(1280, 900);
});

test("the phone dock lands inside the first phone screen with an empty bench", async () => {
  // The empty hero is sized as `100svh - --hero-chrome`, so every band the page
  // spends outside the hero has to be in that budget. The dock is fixed to the
  // bottom edge, so it is always on screen - what has to hold is that the hero
  // does not grow behind it.
  //
  // Only viewports tall enough to clear the hero's 300px min-height are checked.
  // Below roughly 575px of svh that floor wins over the budget on purpose - a
  // hero sized to the leftover space there would be too small to aim at - and
  // the page is meant to scroll.
  for (const [width, height] of [
    [320, 640],
    [360, 640],
    [390, 844],
    [430, 932],
  ]) {
    await page.viewport(width, height);
    mountWebappRoot();
    await expect.poll(() => document.querySelector(".step.is-input.is-empty .drop.hero")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".dock")?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(height + 1);
    await expect.poll(() => document.querySelector(".dock")?.getBoundingClientRect().top ?? 0).toBeGreaterThan(0);
  }
  await page.viewport(1280, 900);
});

test("PWA side insets move dock content without shifting the shell", async () => {
  const safeLeft = 18;
  const safeRight = 18;
  const height = 852;
  await page.viewport(393, height);
  mountWebappRoot();
  await expect.poll(() => document.querySelector(".dock")).toBeTruthy();
  const readLayout = () => {
    const masthead = document.querySelector(".masthead")?.getBoundingClientRect();
    const dock = document.querySelector(".dock")?.getBoundingClientRect();
    const controls = [...document.querySelectorAll(".dock-tab, .dock-action")].filter(
      (control) => getComputedStyle(control).display !== "none",
    );
    return {
      dockBottom: dock?.bottom ?? 0,
      dockTop: dock?.top ?? 0,
      firstControlLeft: controls[0]?.getBoundingClientRect().left ?? 0,
      lastControlRight: controls.at(-1)?.getBoundingClientRect().right ?? 0,
      mastheadTop: masthead?.top ?? 0,
    };
  };
  const before = readLayout();
  const simulatedSafeArea = document.createElement("style");
  simulatedSafeArea.textContent = `.rw-app { --safe-l: ${safeLeft}px; --safe-r: ${safeRight}px; }`;
  document.head.append(simulatedSafeArea);
  try {
    const after = readLayout();
    expect(after.mastheadTop).toBe(before.mastheadTop);
    expect(after.dockTop).toBe(before.dockTop);
    expect(after.dockBottom).toBe(before.dockBottom);
    expect(after.firstControlLeft).toBeGreaterThan(before.firstControlLeft);
    expect(after.lastControlRight).toBeLessThan(before.lastControlRight);
  } finally {
    simulatedSafeArea.remove();
  }
  await page.viewport(1280, 900);
});

test("PWA vertical insets keep the dock clear of the home indicator", async () => {
  const safeTop = 59;
  const safeBottom = 34;
  const height = 852;
  await page.viewport(393, height);
  mountWebappRoot();
  await expect.poll(() => document.querySelector(".dock")).toBeTruthy();
  const simulatedSafeArea = document.createElement("style");
  simulatedSafeArea.textContent = `.rw-app { --safe-t: ${safeTop}px; --safe-b: ${safeBottom}px; }`;
  document.head.append(simulatedSafeArea);
  try {
    await expect
      .poll(() => document.querySelector(".masthead")?.getBoundingClientRect().top ?? -1)
      .toBeGreaterThanOrEqual(safeTop);
    await expect
      .poll(() => document.querySelector(".dock")?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(height + 1);
    // the last dock tab sits above the home indicator, not under it
    await expect
      .poll(() => document.querySelector(".dock-tab")?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(height - safeBottom + 1);
  } finally {
    simulatedSafeArea.remove();
  }
  await page.viewport(1280, 900);
});

test("the mobile scroll reserve returns once the bench holds a card", async () => {
  // The reserve keeps the last card clear of the phone browser's collapsing
  // bottom toolbar. It is only suppressed while the bench is empty; dropping
  // the suppression on a staged bench would hide the run/download slot again.
  await page.viewport(390, 844);
  mountWebappRoot();
  const workflowBody = await waitForState(() => document.querySelector(".workflow-body"));
  expect(workflowBody).not.toBeNull();
  // The harness mounts the prerender shell with its boot flag still set; clear
  // it before checking the settled, non-empty workflow's scroll reserve.
  document.querySelector("#webapp-root")?.removeAttribute("aria-busy");
  expect(getComputedStyle(workflowBody).paddingBlockEnd).toBe("0px");

  document.querySelector(".step.is-input.is-empty").classList.remove("is-empty");
  expect(getComputedStyle(workflowBody).paddingBlockEnd).toBe("96px");
  await page.viewport(1280, 900);
});

test("the New here? beacon stays compact and its popover carries every start action", async () => {
  await page.viewport(1024, 900);
  mountWebappRoot();

  await expect.poll(() => document.querySelector(".sample-tutorial-start-chip")).toBeInstanceOf(HTMLButtonElement);
  const chip = document.querySelector(".sample-tutorial-start-chip");
  const chipBox = chip.getBoundingClientRect();
  expect(chipBox.height).toBeLessThan(40);
  // The chip rides the hero's lower corner instead of spending a band below it.
  const hero = document.querySelector(".drop.hero").getBoundingClientRect();
  expect(chipBox.bottom).toBeLessThanOrEqual(hero.bottom + 1);
  // Closed popover is not mounted at all - it must stay out of the prerendered shell.
  expect(document.querySelector(".sample-tutorial-start-pop")).toBeNull();

  chip.click();
  await expect.poll(() => document.querySelectorAll(".sample-tutorial-start-action").length).toBe(3);
  expect(document.querySelector(".sample-tutorial-start-primary")?.getAttribute("href")).toBe("/apply?guide=apply");
  expect(document.querySelector(".sample-tutorial-start-secondary")?.getAttribute("href")).toBe("/apply?guide=bundle");
  const pop = document.querySelector(".sample-tutorial-start-pop").getBoundingClientRect();
  expect(pop.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
  expect(pop.top).toBeGreaterThanOrEqual(0);

  await page.viewport(360, 740);
  await expect
    .poll(() => document.querySelector(".sample-tutorial-start-pop").getBoundingClientRect().right)
    .toBeLessThanOrEqual(document.documentElement.clientWidth);
  expect(document.querySelector(".sample-tutorial-start-pop").getBoundingClientRect().left).toBeGreaterThanOrEqual(0);

  // Dismissal hides the beacon in place.
  document.querySelector(".sample-tutorial-start-dismiss").click();
  await expect.poll(() => document.querySelector(".sample-tutorial-start-chip")).toBeNull();

  // The persisted form of the same choice: onboardingEnabled=false renders no beacon.
  mountWebappRoot({ settings: { ...getDefaultSettings(), onboardingEnabled: false } });
  await expect.poll(() => document.querySelector(".drop.hero")).toBeTruthy();
  expect(document.querySelector(".sample-tutorial-start-chip")).toBeNull();
});

test("WebappRoot resolves an auto thread count the same way the Threads setting does", async () => {
  // "auto" in the masthead must agree with the Threads field's `auto (N)`
  // placeholder. Raw navigator.hardwareConcurrency disagrees with it on any
  // host below the 4-thread floor - 2 cores read "2 threads" against "auto (4)".
  // Two cores is below the 4-thread floor, so the two resolvers can only agree
  // if the masthead uses the shared one.
  const hardwareConcurrency = Object.getOwnPropertyDescriptor(Navigator.prototype, "hardwareConcurrency");
  Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 2 });
  try {
    const expected = getDefaultBrowserThreadCount();
    expect(expected).not.toBe(2);
    mountWebappRoot({ settings: { ...getDefaultSettings(), threads: "auto" } });
    await expect
      .poll(() => document.querySelector(".masthead-threads")?.getAttribute("aria-label") || "")
      .toContain(`${expected} threads`);
  } finally {
    Reflect.deleteProperty(navigator, "hardwareConcurrency");
    if (hardwareConcurrency) Object.defineProperty(Navigator.prototype, "hardwareConcurrency", hardwareConcurrency);
  }
});

test("WebappRoot keeps diagnostics behind More - the Log dialog owns them", async () => {
  // Settings stays direct; Docs is a top-level route and diagnostics share More.
  mountWebappRoot();
  await expect.element(page.getByRole("button", { name: "More" })).toBeInTheDocument();
  await page.getByRole("button", { name: "More" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Logs" })).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Copy console logs" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Mobile dev tools" })).not.toBeInTheDocument();
});

test("mobile diagnostics keep the Storage tab on one tab row", async () => {
  const height = 844;
  await page.viewport(393, height);
  mountWebappRoot();

  await expect.poll(() => document.querySelector(".masthead-status")).toBeTruthy();
  document.querySelector(".masthead-status")?.click();
  await expect.poll(() => document.querySelector(".log-dlg .dialog-subrail")).toBeTruthy();

  const rail = document.querySelector(".log-dlg .dialog-subrail");
  const tabs = Array.from(document.querySelectorAll(".log-dlg .dialog-subrail .subtab"));
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Settings", "Status", "Logs", "Storage", "Changelog"]);
  expect(new Set(tabs.map((tab) => tab.getBoundingClientRect().top)).size).toBe(1);
  expect(rail?.scrollHeight).toBe(rail?.clientHeight);
  expect(document.querySelector('[data-logtab="test"]')).toBeNull();
  expect(document.querySelector("#logpanel-status .emulator-prefetch-panel")).toBeNull();

  document.querySelector('[data-logtab="storage"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await expect.poll(() => document.querySelector("#logpanel-storage .opfs-inspector")).toBeTruthy();
  expect(document.querySelector("#logpanel-storage .emulator-saves-panel")).toBeNull();
  expect(document.querySelector("#logpanel-storage .storage-settings-field")).toBeNull();
  expect(document.querySelector("#logpanel-storage .emulator-prefetch-panel")).toBeNull();
  expect(document.querySelector("#storage-opfs-title")?.textContent).toBe("OPFS");
  await page.viewport(1280, 900);
});

test("mobile More carries app utilities plus the external links, and the footer keeps them too", async () => {
  await page.viewport(390, 844);
  mountWebappRoot();

  await expect.poll(() => document.querySelector(".masthead-tools")).toBeTruthy();
  const footer = document.querySelector(".site-footer");
  expect(footer).not.toBeNull();
  for (const [label, href] of [
    ["View source on GitHub", "https://github.com/rom-weaver/rom-weaver/"],
    ["Support", "https://ko-fi.com/brandonocasey"],
  ]) {
    const link = page.getByRole("link", { name: label });
    await expect.element(link).toBeInTheDocument();
    expect([...footer.querySelectorAll("a")].some((node) => node.getAttribute("href") === href)).toBe(true);
  }
  const mastheadStatus = document.querySelector(".masthead-status");
  for (const selector of [".masthead-status", ".mobile-utility-theme", ".mobile-utility-accent"]) {
    const control = document.querySelector(selector);
    expect(control).not.toBeNull();
    expect(getComputedStyle(control).display).not.toBe("none");
  }

  await page.getByRole("button", { name: "More" }).click();
  for (const label of ["Status", "Theme", "Accent"]) {
    await expect.element(page.getByRole("menuitem", { name: label })).toBeInTheDocument();
  }
  for (const [label, href] of [
    ["View source on GitHub", "https://github.com/rom-weaver/rom-weaver/"],
    ["Support", "https://ko-fi.com/brandonocasey"],
  ]) {
    const item = page.getByRole("menuitem", { name: label });
    await expect.element(item).toBeInTheDocument();
    expect(item.element().getAttribute("href")).toBe(href);
  }
  expect(document.querySelector('.more-menu [role="menuitem"][data-sw] svg')?.outerHTML).toBe(
    document.querySelector(".masthead-status svg")?.outerHTML,
  );
  const menuStatus = document.querySelector(".more-menu .more-status");
  expect(menuStatus).not.toBeNull();
  expect(getComputedStyle(menuStatus).color).toBe(getComputedStyle(mastheadStatus).color);
  expect(getComputedStyle(menuStatus.querySelector("svg")).color).toBe(getComputedStyle(mastheadStatus).color);
  const neutralItem = document.querySelector('.more-menu [role="menuitem"]:not(.more-status, .more-support)');
  const neutralColor = getComputedStyle(neutralItem).color;
  for (const item of document.querySelectorAll('.more-menu [role="menuitem"]')) {
    if (item.classList.contains("more-status")) continue;
    if (item.classList.contains("more-support")) {
      expect(getComputedStyle(item).color).not.toBe(neutralColor);
      expect(getComputedStyle(item.querySelector("svg")).color).toBe(getComputedStyle(item).color);
      continue;
    }
    expect(getComputedStyle(item).color).toBe(neutralColor);
    expect(getComputedStyle(item.querySelector("svg")).color).toBe(neutralColor);
  }
  await page.getByRole("menuitem", { name: "Accent" }).click();
  await expect.element(page.getByRole("radiogroup", { name: "Accent" })).toBeInTheDocument();

  const buildTag = document.querySelector(".build-tag");
  expect(buildTag?.textContent).toMatch(/v\d/);
  const badge = buildTag?.querySelector(".channel-badge");
  if (badge) {
    expect(getComputedStyle(badge).display).not.toBe("none");
    expect(badge.textContent).toMatch(/v\d/);
  }
  const previewVersion = buildTag?.querySelector(".tag-extra");
  if (previewVersion) expect(getComputedStyle(previewVersion).display).not.toBe("none");

  await page.viewport(1280, 900);
});
