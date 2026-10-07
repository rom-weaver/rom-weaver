import { createElement, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";
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
  // The helper accepts either a checklist with confirmation or a clickable single-select tree.
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
  onSaveEditorSessionChange: () => undefined,
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

function WebappRootHarness({ initialView = "patcher", settings, updateReady = false, onReloadUpdate } = {}) {
  const [currentView, setCurrentView] = useState(initialView);
  const props = useMemo(
    () => ({
      actions: { ...createNoopActions(), onSelectView: setCurrentView, onReloadUpdate },
      confirmationDialog: createEmptyConfirmationDialogState(),
      pageUpdate: { ...createEmptyPageUpdateState(), ready: updateReady },
      serviceWorkerCache: createServiceWorkerCacheState(),
      state: createWebappState(settings, currentView),
    }),
    [currentView, settings, updateReady, onReloadUpdate],
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
  document.documentElement.dataset.offlineLayout = "strip";
  mountedRoot?.unmount?.();
  mountedRoot = null;
  // A console section hash reopens the console on mount, so a test that left
  // it open must not open it for the next one.
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  rootElement = document.createElement("div");
  rootElement.id = "webapp-root";
  rootElement.setAttribute("aria-busy", "true");
  document.body.replaceChildren(rootElement);
});

/** A nav row by its visible label, from whichever layout the test names. */
const navRow = (name, scope = ".side-nav") =>
  [...document.querySelectorAll(`${scope} .nav-row, ${scope} .guide-nav a`)].find(
    (row) =>
      !row.hidden && (row.querySelector(".nav-row-label")?.firstChild?.textContent ?? row.textContent)?.trim() === name,
  );
const openMenuSheet = async () => {
  await expect.poll(() => document.querySelector(".dock-menu")).toBeTruthy();
  document.querySelector(".dock-menu").click();
  await expect.poll(() => document.querySelector(".menu-sheet")?.hidden).toBe(false);
  return document.querySelector(".menu-sheet");
};

test("WebappRoot mounts the full workflow shell and stages archive inputs", async () => {
  // Trim is beta-gated (see `betaToolsEnabled`), so the full-shell assertions
  // below require the flag on - matching the pattern the sibling controller unit tests use.
  mountWebappRoot({ settings: { ...getDefaultSettings(), betaToolsEnabled: true } });

  // The unified drop surface is the only input now; its label flips once the workflow has files.
  const romInput = page.getByLabelText(/ROMs, patches, bundles, or archives/i);

  await expect.element(romInput).toBeInTheDocument();

  await expect.element(page.getByRole("navigation", { name: "Workflow" }).first()).toBeInTheDocument();
  await expect.poll(() => navRow("Apply")).toBeTruthy();
  await expect.poll(() => navRow("Create")).toBeTruthy();
  // Beta workflows are named in the nav itself, not filed under an overflow.
  await expect.poll(() => navRow("PPF undo")).toBeTruthy();

  await romInput.upload(await loadFixtureFile(ONE_ROM_ZIP, "application/zip"));
  await selectCandidateIfPrompted("game.bin");

  await waitForInputStackFile("game.bin");
  await expect.element(page.getByText(CRC32_TEXT_REGEX)).toBeInTheDocument();
  // The output section (and its apply button) renders once the workflow has files.
  await expect.element(page.getByRole("button", { name: "Apply & download" })).toBeInTheDocument();

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

test("WebappRoot keeps the beta workflows out of the nav while the setting is off", async () => {
  mountWebappRoot();
  // The dock keeps its three workflow slots plus Menu and Controls at every setting.
  await expect
    .poll(() => [...document.querySelectorAll(".dock .dock-tab")].map((tab) => tab.textContent))
    .toEqual(["Apply", "Create", "Menu", "Test", "Controls"]);
  expect(navRow("PPF undo")).toBeTruthy();
  expect(navRow("PPF undo").querySelector(".nav-beta")).toBeNull();
  expect(navRow("Identify")).toBeTruthy();
  navRow("Identify").click();
  await expect.poll(() => document.querySelector("#identify-input-picker") !== null).toBe(true);
  // Tool pages MUST offer one Docs destination, not the full guide tree.
  const docsLink = navRow("Docs");
  expect(docsLink).toBeTruthy();
  expect(docsLink.closest("summary")).toBeNull();
  expect(document.querySelector(".nav-docs-toggle")).toBeNull();
  expect(docsLink.closest("details")).toBeNull();
  expect(document.querySelector(".guide-nav")).toBeNull();
  expect(navRow("Home")).toBeTruthy();
});

test("Docs topic headings keep their width and wrapping when expanded", async () => {
  mountWebappRoot({ initialView: "docs" });
  await expect.poll(() => document.querySelector(".side-nav .guide-nav")).toBeTruthy();
  await document.fonts.ready;
  await page.viewport(1280, 1200);
  const nav = document.querySelector(".side-rail .guide-nav");
  expect(nav.querySelectorAll(":scope > .guide-nav-list a")).toHaveLength(2);
  expect(nav.querySelector(".guide-shelf-title")?.textContent).toBe("Walkthroughs");
  // Shelf names read as sentence case, the same as the phone drawer rows.
  expect(getComputedStyle(nav.querySelector(".guide-shelf-title")).textTransform).toBe("none");
  expect(nav.querySelectorAll(".guide-branch")).toHaveLength(0);
  const headings = [...nav.querySelectorAll(":scope > details > summary")];
  const sizes = () =>
    headings.map((heading) => {
      const bounds = heading.getBoundingClientRect();
      return [bounds.width, bounds.height];
    });
  const before = sizes();
  for (const heading of headings) {
    const wasOpen = heading.parentElement.open;
    heading.click();
    await expect.poll(() => heading.parentElement.open).toBe(!wasOpen);
    expect(sizes()).toEqual(before);
    heading.click();
    await expect.poll(() => heading.parentElement.open).toBe(wasOpen);
  }
  await page.viewport(1280, 900);
});

test("mobile Docs docks one docs bar on the workflow dock and opens everything from it", async () => {
  await page.viewport(390, 844);
  mountWebappRoot({ initialView: "docs" });
  await expect.poll(() => document.querySelector(".docs-bar")).toBeTruthy();
  const dock = document.querySelector(".dock");
  const bar = document.querySelector(".docs-bar");
  expect([...dock.querySelectorAll(".dock-tab")].map((tab) => tab.textContent)).toEqual([
    "Apply",
    "Create",
    "Menu",
    "Test",
    "Controls",
  ]);
  // Flush on the dock: part of the bottom chrome, never floating over the article.
  expect(getComputedStyle(bar).position).toBe("fixed");
  expect(Math.abs(bar.getBoundingClientRect().bottom - dock.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
  expect(bar.getBoundingClientRect().height).toBeLessThanOrEqual(60);
  expect(document.querySelector(".docs-browse-trigger, .docs-trail, #docs-menu-sheet")).toBeNull();

  const open = bar.querySelector(".docs-bar-open");
  const drawer = document.querySelector("#docs-drawer");
  expect(open.textContent).toBe("Docs");
  open.focus();
  open.click();
  await expect.poll(() => drawer.hidden).toBe(false);
  expect(open.textContent).toBe("Close");
  // Polled: the drawer rises into place.
  await expect
    .poll(() => drawer.getBoundingClientRect().bottom - bar.getBoundingClientRect().top)
    .toBeLessThanOrEqual(1);
  expect(drawer.querySelector(".docs-row").getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  expect(drawer.querySelector('[aria-pressed="true"]')?.textContent).toBe("Browser");
  drawer.querySelector(".docs-row").click();
  await expect.poll(() => drawer.querySelector(".docs-drawer-back")).toBeTruthy();
  drawer.querySelector(".docs-drawer-back").click();
  await expect.poll(() => drawer.querySelector(".docs-drawer-back")).toBeNull();
  // The bar stays above the scrim, so the same button closes the drawer.
  open.click();
  await expect.poll(() => drawer.hidden).toBe(true);
  await expect.poll(() => document.activeElement).toBe(open);

  const where = bar.querySelector(".docs-bar-where");
  if (!where.disabled) {
    const parts = document.querySelector("#docs-parts");
    where.click();
    await expect.poll(() => parts.hidden).toBe(false);
    await expect
      .poll(() => parts.getBoundingClientRect().bottom - bar.getBoundingClientRect().top)
      .toBeLessThanOrEqual(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await expect.poll(() => parts.hidden).toBe(true);
    await expect.poll(() => document.activeElement).toBe(where);
  }

  open.click();
  await expect.poll(() => drawer.hidden).toBe(false);
  const menu = document.querySelector(".dock-menu");
  menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  menu.click();
  const globalMenu = document.querySelector("#menu-sheet");
  await expect.poll(() => globalMenu.hidden).toBe(false);
  expect(drawer.hidden).toBe(true);
  expect(navRow("Docs", "#menu-sheet").closest(".nav-group")).toBe(navRow("Home", "#menu-sheet").closest(".nav-group"));
  expect(globalMenu.querySelector(".guide-nav")).toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  await expect.poll(() => globalMenu.hidden).toBe(true);

  await page.viewport(1000, 844);
  // Desktop keeps the rails: the bar's layer leaves the layout entirely.
  await expect.poll(() => bar.getClientRects().length).toBe(0);
  expect(document.querySelector('.side-nav a[href="/apply-patches"]')?.textContent).toBe("Back to tools");
  await page.viewport(1280, 900);
});

const dropOnPage = async (fileName) => {
  const transfer = new DataTransfer();
  transfer.items.add(new File([new Uint8Array([1, 2, 3, 4])], fileName));
  document.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
};

/**
 * Keep exactly one Identify form mounted so a page drop has one consumer and one activity-store publisher.
 */
test("only one Identify workflow ever consumes a page drop", async () => {
  await page.viewport(1280, 900);
  mountWebappRoot({ initialView: "identify", settings: { ...getDefaultSettings(), betaToolsEnabled: true } });
  await expect.poll(() => document.querySelectorAll("#identify-input-picker").length).toBe(1);

  await dropOnPage("first.gba");
  await expect.poll(() => document.querySelector("#identify-container")?.textContent).toContain("first.gba");

  navRow("PPF undo").click();
  await expect.poll(() => document.querySelector("#panel-ppf-undo")?.hidden).toBe(false);
  // The Identify panel stays mounted behind PPF undo, so the count also proves the
  // hidden instance is the SAME one, not a second form.
  expect(document.querySelectorAll("#identify-input-picker")).toHaveLength(1);

  await dropOnPage("second.ppf");
  await expect.poll(() => document.querySelector("#identify-container")?.textContent).not.toContain("second.ppf");
  expect(document.querySelector("#identify-container")?.textContent).toContain("first.gba");
});

test("enabled PPF undo and Identify are named in the nav on desktop and phone", async () => {
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    await page.viewport(width, height);
    mountWebappRoot({ initialView: "identify", settings: { ...getDefaultSettings(), betaToolsEnabled: true } });
    const scope = width >= 1000 ? ".side-nav" : ".menu-sheet";
    if (width < 1000) await openMenuSheet();
    await expect.poll(() => navRow("PPF undo", scope)).toBeTruthy();
    // Each beta tool has its own route and its own named row in both layouts.
    await expect.poll(() => navRow("Identify", scope)).toBeTruthy();
    navRow("PPF undo", scope).click();
    // Only ONE Identify form can exist. PPF undo links nowhere near it, so a page
    // drop has exactly one consumer and the two cannot fight over the activity key.
    expect(document.querySelectorAll("#identify-input-picker")).toHaveLength(1);
    expect(document.querySelector("#ppf-undo-identify-input-picker")).toBeNull();
    // Neither beta tool takes one of the dock's three workflow slots.
    expect(document.querySelector(`.dock-tab[data-mode="identify"]`)).toBeNull();
    expect(document.querySelector(`.dock-tab[data-mode="ppf-undo"]`)).toBeNull();
    expect(getComputedStyle(document.querySelector(".panel-view-toggle")).display).not.toBe("none");
    // Both layouts list every destination, App's included, under the same groups.
    if (width < 1000) await openMenuSheet();
    for (const name of ["Docs", "Support", "Settings", "Offline app", "Saves & storage", "Logs"]) {
      expect(navRow(name, scope)).toBeTruthy();
    }
    if (width < 1000) {
      expect(document.querySelector(".phone-runtime .sub-status")).toBeTruthy();
      expect(document.querySelector(".dock-app")).toBeTruthy();
    }
  }
  await page.viewport(1280, 900);
});

test("WebappRoot reports the configured thread count before the workflow view toggle", async () => {
  mountWebappRoot({ settings: { ...getDefaultSettings(), threads: 1 } });
  await expect
    .poll(() => document.querySelector("#panel-patcher .panel-threads-btn")?.textContent || "")
    .toContain("1 thread");
  expect(document.querySelector(".masthead-threads")).toBeNull();
  const threadButton = document.querySelector("#panel-patcher .panel-threads-btn");
  const viewToggle = document.querySelector("#panel-patcher .panel-view-toggle");
  expect(threadButton.compareDocumentPosition(viewToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("the wordmark keeps its version while persistent status sits beside navigation", async () => {
  await page.viewport(1280, 900);
  mountWebappRoot({ settings: { ...getDefaultSettings(), threads: 10 } });
  await expect
    .poll(() => document.querySelector(".desktop-runtime .sub-status")?.getAttribute("aria-label") || "")
    .not.toBe("");
  expect(document.querySelector(".masthead-threads")).toBeNull();
  expect(document.querySelector(".brand-copy .build-facts")).toBeTruthy();
  expect(document.querySelector(".brand .sub-status")).toBeNull();
  await expect
    .poll(() => document.querySelector("#panel-patcher .panel-threads-btn")?.textContent || "")
    .toContain("10 threads");

  for (const [width, height] of [
    [1280, 900],
    [1100, 900],
    [320, 844],
    [390, 844],
  ]) {
    await page.viewport(width, height);
    const slot = width >= 1000 ? ".desktop-runtime" : ".phone-runtime";
    const status = document.querySelector(`${slot} .sub-status`);
    expect(status.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(status.querySelector(".sub-status-text")?.textContent?.trim()).not.toBe("");
    const version = document.querySelector(".brand .build-tag .sub-chip");
    expect(version.scrollWidth).toBeLessThanOrEqual(version.clientWidth);
    if (width >= 1000) {
      expect(document.querySelector(".topbar .sub-status")).toBe(status);
      expect(status.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        document.querySelector(".side-nav").getBoundingClientRect().top,
      );
    } else {
      expect(document.querySelector(".dock-menu")?.getAttribute("aria-label")).toBe("Menu");
      expect(status.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        document.querySelector(".dock-tab").getBoundingClientRect().top,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const brand = document.querySelector(".brand").getBoundingClientRect();
      const tools = document.querySelector(".shell-head-tools").getBoundingClientRect();
      expect(brand.right).toBeLessThanOrEqual(tools.left);
      expect(tools.height).toBe(44);
    }
    // The wordmark still leads the block it heads.
    const titleSize = Number.parseFloat(getComputedStyle(document.querySelector(".brand-word")).fontSize);
    const factsSize = Number.parseFloat(getComputedStyle(document.querySelector(".build-facts")).fontSize);
    expect(titleSize).toBeGreaterThan(factsSize * 1.4);
    expect(document.querySelector(".brand-mark").getBoundingClientRect().top).toBeLessThanOrEqual(
      document.querySelector(".brand-word").getBoundingClientRect().top + 2,
    );
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
  let heroBudgetReduced = false;
  for (const [width, height] of [
    [320, 640],
    [360, 640],
    [390, 844],
    [430, 932],
  ]) {
    await page.viewport(width, height);
    mountWebappRoot();
    await expect.poll(() => document.querySelector(".step.is-input.is-empty .drop.hero")).toBeTruthy();
    const heroBeforeGap = document.querySelector(".step.is-input.is-empty .drop.hero").getBoundingClientRect().height;
    const simulatedPwaGap = document.createElement("style");
    simulatedPwaGap.textContent = ".rw-app { --pwa-top-gap: 4px; }";
    document.head.append(simulatedPwaGap);
    const heroAfterGap = document.querySelector(".step.is-input.is-empty .drop.hero").getBoundingClientRect().height;
    expect(heroAfterGap).toBeLessThanOrEqual(heroBeforeGap);
    heroBudgetReduced ||= heroAfterGap <= heroBeforeGap - 3.9;
    await expect
      .poll(() => document.querySelector(".dock")?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(height + 1);
    await expect.poll(() => document.querySelector(".dock")?.getBoundingClientRect().top ?? 0).toBeGreaterThan(0);
    simulatedPwaGap.remove();
  }
  expect(heroBudgetReduced).toBe(true);
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
    const masthead = document.querySelector(".shell-head")?.getBoundingClientRect();
    const dock = document.querySelector(".dock")?.getBoundingClientRect();
    const controls = [...document.querySelectorAll(".dock-tab")].filter(
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
  const topGap = 4;
  const height = 852;
  await page.viewport(393, height);
  mountWebappRoot();
  await expect.poll(() => document.querySelector(".dock")).toBeTruthy();
  const simulatedSafeArea = document.createElement("style");
  simulatedSafeArea.textContent = `.rw-app { --safe-t: ${safeTop}px; --safe-b: ${safeBottom}px; --pwa-top-gap: ${topGap}px; }`;
  document.head.append(simulatedSafeArea);
  try {
    await expect
      .poll(() => document.querySelector(".shell-head")?.getBoundingClientRect().top ?? -1)
      .toBeGreaterThanOrEqual(safeTop + topGap);
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

test.each([
  ["patcher", "/apply-patches?guide=apply", "/docs/apply-rom-patches"],
  ["bundle", "/bundle-patches?guide=bundle", "/docs/create-bundles"],
])("the %s New here? beacon carries its own guide and the download", async (initialView, guideHref, docsPath) => {
  await page.viewport(1024, 900);
  mountWebappRoot({ initialView });

  await expect
    .poll(() => document.querySelector(".sample-tutorial-start .sample-tutorial-start-chip"))
    .toBeInstanceOf(HTMLButtonElement);
  const chip = document.querySelector(".sample-tutorial-start .sample-tutorial-start-chip");
  const chipBox = chip.getBoundingClientRect();
  expect(chipBox.height).toBeGreaterThanOrEqual(44);
  expect(chipBox.height).toBeLessThanOrEqual(48);
  const hero = document.querySelector(".drop.hero").getBoundingClientRect();
  expect(chipBox.top).toBeGreaterThanOrEqual(hero.bottom);
  // Closed popover is not mounted at all - it must stay out of the prerendered shell.
  expect(document.querySelector(".sample-tutorial-start-pop")).toBeNull();

  chip.click();
  const secondaryHref = initialView === "patcher" ? "/apply-patches?guide=apply-cheats" : null;
  await expect
    .poll(() => document.querySelectorAll(".sample-tutorial-start-action").length)
    .toBe(secondaryHref ? 5 : 4);
  expect(document.querySelector(".sample-tutorial-start-primary")?.getAttribute("href")).toBe(guideHref);
  expect(document.querySelector(".sample-tutorial-start-secondary")?.getAttribute("href") ?? null).toBe(secondaryHref);
  expect(document.querySelector(".sample-tutorial-start-guide")?.pathname).toBe(docsPath);
  expect(document.querySelector(".hero-guide")?.pathname).toBe(docsPath);
  expect(document.querySelector(".sample-tutorial-start-download").hasAttribute("download")).toBe(true);
  expect(document.querySelector(".sample-tutorial-start-dismiss")).toBeTruthy();
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
  await expect.poll(() => document.querySelector(".sample-tutorial-start .sample-tutorial-start-chip")).toBeNull();

  // The persisted form of the same choice: onboardingEnabled=false renders no beacon.
  mountWebappRoot({ initialView, settings: { ...getDefaultSettings(), onboardingEnabled: false } });
  await expect.poll(() => document.querySelector(".drop.hero")).toBeTruthy();
  expect(document.querySelector(".sample-tutorial-start .sample-tutorial-start-chip")).toBeNull();
});

test("WebappRoot resolves an auto thread count the same way the Threads setting does", async () => {
  const hardwareConcurrency = Object.getOwnPropertyDescriptor(Navigator.prototype, "hardwareConcurrency");
  Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 2 });
  try {
    const expected = getDefaultBrowserThreadCount();
    expect(expected).not.toBe(2);
    mountWebappRoot({ settings: { ...getDefaultSettings(), threads: "auto" } });
    await expect
      .poll(() => document.querySelector("#panel-patcher .panel-threads-btn")?.textContent || "")
      .toContain(`${expected} threads`);
  } finally {
    Reflect.deleteProperty(navigator, "hardwareConcurrency");
    if (hardwareConcurrency) Object.defineProperty(Navigator.prototype, "hardwareConcurrency", hardwareConcurrency);
  }
});

test("WebappRoot names diagnostics in the nav - the settings console owns them", async () => {
  // Offline app, Saves & storage and Logs are each their own row; the console
  // they open is still the one place the detail lives.
  mountWebappRoot();
  await expect.poll(() => navRow("Logs")).toBeTruthy();
  expect(navRow("Offline app")).toBeTruthy();
  expect(navRow("Saves & storage")).toBeTruthy();
  await expect.element(page.getByRole("button", { name: "Copy console logs" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Mobile dev tools" })).not.toBeInTheDocument();
});

test("navigation Offline app keeps a plain label and opens the current offline view", async () => {
  await page.viewport(1280, 900);
  mountWebappRoot({ updateReady: true });
  await expect.poll(() => navRow("Offline app")).toBeTruthy();
  expect(navRow("Offline app").querySelector(".nav-row-label").textContent).toBe("Offline app");
  expect(navRow("Offline app").querySelector(".nav-row-state")).toBeNull();
  navRow("Offline app").click();
  await expect
    .poll(() => document.querySelector(".log-dlg[open] #logpanel-offline .sw-legend [data-current]"))
    .toBeTruthy();
  expect(
    document.querySelector(".log-dlg #logpanel-offline .sw-legend [data-current] .sw-legend-label")?.textContent,
  ).toContain("Update available");
});

test("the phone console keeps its five sections and Close on one bar at the foot", async () => {
  const height = 844;
  await page.viewport(393, height);
  mountWebappRoot();

  await expect.poll(() => document.querySelector(".dock-app")).toBeTruthy();
  document.querySelector(".dock-app").click();
  await expect.poll(() => document.querySelector(".log-dlg[open] .console-nav")).toBeTruthy();

  const nav = document.querySelector(".log-dlg .console-nav");
  const close = nav.querySelector(".console-close");
  const items = [...nav.querySelectorAll(".console-tab"), close];
  const visibleLabel = (item) => item.querySelector(item === close ? "span" : ".console-tab-short");
  expect(items.map((item) => visibleLabel(item)?.textContent)).toEqual([
    "Settings",
    "Offline",
    "Storage",
    "Logs",
    "About",
    "Close",
  ]);
  // Close takes the bottom-right corner, after every section.
  expect(close.getBoundingClientRect().right).toBeGreaterThan(nav.getBoundingClientRect().right - 20);
  expect(new Set(items.map((item) => Math.round(item.getBoundingClientRect().top))).size).toBe(1);
  expect(nav.getBoundingClientRect().bottom).toBeGreaterThan(height - 100);
  expect(nav.querySelector(".console-nav-foot")?.getBoundingClientRect().height ?? 0).toBe(0);

  // Storage shows the saves; the raw OPFS listing waits for Advanced.
  document.querySelector('[data-logtab="storage"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await expect.poll(() => document.querySelector("#logpanel-storage .emulator-saves-panel")).toBeTruthy();
  expect(document.querySelector("#logpanel-storage .opfs-inspector")).toBeNull();
  document.querySelector("#console-advanced-phone").click();
  await expect.poll(() => document.querySelector("#logpanel-storage .opfs-inspector")).toBeTruthy();
  expect(document.querySelector("#storage-opfs-title")?.textContent).toBe("OPFS");
  document.querySelector("#console-advanced-phone").click();

  // Close slides the page out and closes the console.
  close.click();
  await expect.poll(() => document.querySelector(".log-dlg")).toBeNull();
  await page.viewport(1280, 900);
});

test("a phone console swipe closes past a quarter of the width and springs back after a hold", async () => {
  await page.viewport(393, 844);
  mountWebappRoot();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const openConsole = async () => {
    document.querySelector(".dock-app").click();
    await expect.poll(() => document.querySelector(".log-dlg[open] .console-nav")).toBeTruthy();
    // The page MUST finish sliding in, or the swipe starts from a moving frame.
    await pause(400);
  };
  const swipe = async (points, holdMs) => {
    const tab = document.querySelector('.log-dlg [data-logtab="storage"]');
    const { top, height } = tab.getBoundingClientRect();
    const send = (type, clientX) =>
      tab.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX,
          clientY: top + height / 2,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    send("pointerdown", points[0]);
    for (const x of points.slice(1)) {
      await pause(30);
      send("pointermove", x);
    }
    await pause(holdMs);
    send("pointerup", points.at(-1));
  };

  await expect.poll(() => document.querySelector(".dock-app")).toBeTruthy();
  await openConsole();
  // A quick 80px (about 20%) drag that stops before release is no flick.
  await swipe([40, 80, 120], 200);
  await pause(400);
  expect(document.querySelector(".log-dlg[open]")).toBeTruthy();

  // A slow drag past a quarter of the width (about 28%) closes.
  await swipe([40, 60, 80, 100, 120, 140, 150], 200);
  await expect.poll(() => document.querySelector(".log-dlg")).toBeNull();
  await page.viewport(1280, 900);
});

test("the phone header carries the desktop tools, and Menu carries every destination", async () => {
  await page.viewport(390, 844);
  mountWebappRoot();

  await expect.poll(() => document.querySelector(".shell-head-tools")).toBeTruthy();
  // The footer is gone; the phone header carries the same tools as the desktop top bar.
  expect(document.querySelector(".site-footer")).toBeNull();
  const tiles = [...document.querySelectorAll(".shell-head-tools .tool")];
  expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
    "View source on GitHub",
    "Support",
    document.querySelector(".desktop-runtime .sub-status").getAttribute("aria-label"),
    "Theme: Match system",
    "Accent: Madder",
    "Settings",
  ]);
  expect(document.querySelector('.shell-head-tools [aria-label="Docs"]')).toBeNull();
  for (const tile of tiles) expect(getComputedStyle(tile).display).not.toBe("none");
  for (const [label, href] of [
    ["View source on GitHub", "https://github.com/rom-weaver/rom-weaver/"],
    ["Support", "https://ko-fi.com/brandonocasey"],
  ]) {
    expect(tiles.find((tile) => tile.getAttribute("aria-label") === label).getAttribute("href")).toBe(href);
  }

  await openMenuSheet();
  for (const name of ["Home", "Docs", "GitHub", "Support", "Settings", "Offline app", "Saves & storage", "Logs"]) {
    expect(navRow(name, ".menu-sheet")).toBeTruthy();
  }
  // Theme and accent stay in the header.
  for (const name of ["Theme", "Accent"]) {
    expect(navRow(name, ".menu-sheet")).toBeFalsy();
  }
  expect(document.querySelector(".phone-runtime .sub-status-text").textContent).toBe(
    document.querySelector(".desktop-runtime .sub-status-text").textContent,
  );
  expect(document.querySelector(".menu-sheet .sub-status")).toBeNull();
  expect(navRow("GitHub", ".menu-sheet").getAttribute("href")).toBe("https://github.com/rom-weaver/rom-weaver/");
  expect(navRow("Support", ".menu-sheet").getAttribute("href")).toBe("https://ko-fi.com/brandonocasey");
  // Support is the one row that is not neutral; every other row shares one ink.
  const support = navRow("Support", ".menu-sheet");
  const neutral = getComputedStyle(navRow("Docs", ".menu-sheet")).color;
  expect(getComputedStyle(support).color).not.toBe(neutral);
  expect(getComputedStyle(support.querySelector("svg")).color).toBe(getComputedStyle(support).color);
  for (const row of document.querySelectorAll(".menu-sheet .nav-row")) {
    if (row === support || row.hasAttribute("aria-current")) continue;
    expect(getComputedStyle(row).color).toBe(neutral);
  }

  document.querySelector(".shell-head-tools .accent-tool").click();
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

test("the Menu sheet stays on screen and scrolls on a short screen", async () => {
  // Five tiles across fit every row at 320x480, so the overflow case needs a shorter screen.
  await page.viewport(320, 400);
  mountWebappRoot({ settings: { ...getDefaultSettings(), betaToolsEnabled: true } });

  const sheet = await openMenuSheet();
  expect(sheet.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(sheet.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  // The sheet overlaps the dock edge, and its body is what scrolls.
  const dock = document.querySelector(".dock").getBoundingClientRect();
  expect(sheet.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(dock.top);
  expect(getComputedStyle(document.documentElement).overflow).toBe("hidden");
  const body = sheet.querySelector(".menu-sheet-body");
  expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  expect(navRow("PPF undo", ".menu-sheet")).toBeTruthy();
  const bodyTop = body.getBoundingClientRect().top;
  body.scrollTop = 150;
  expect(body.getBoundingClientRect().top).toBe(bodyTop);
  expect(document.querySelector(".phone-runtime .sub-status-text")?.textContent?.trim()).not.toBe("");
  expect(sheet.querySelector(".find-palette.is-embedded")).toBeTruthy();

  document.querySelector(".dock-app").click();
  await expect.element(page.getByRole("dialog")).toBeInTheDocument();
  await page.viewport(1280, 900);
});

test("Theme and Accent float above the navigation without moving its rows", async () => {
  // Only the sidebar carries them as rows; the phone keeps them in its header.
  for (const [width, height] of [[1280, 900]]) {
    await page.viewport(width, height);
    mountWebappRoot();
    const scope = width < 1000 ? ".menu-sheet" : ".side-nav";
    if (width < 1000) await openMenuSheet();
    await expect.poll(() => document.querySelector(`${scope} .nav-group`)).toBeTruthy();
    const nav = document.querySelector(scope);
    const project = navRow("Home", scope).closest(".nav-group");
    const projectTop = project.offsetTop;
    const navHeight = nav.scrollHeight;

    for (const name of ["Theme", "Accent"]) {
      navRow(name, scope).click();
      await expect.poll(() => nav.querySelector(".nav-tool-pop:popover-open")).toBeTruthy();
      const panel = nav.querySelector(".nav-tool-pop:popover-open");
      const bounds = panel.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(height);
      expect(project.offsetTop).toBe(projectTop);
      expect(nav.scrollHeight).toBe(navHeight);
      navRow(name, scope).click();
    }
  }
  await page.viewport(1280, 900);
});

// The sheet's bottom and the dock's top come from separate layout boxes, so the browser can
// snap them to adjacent device pixels: a 1px gap or overlap is rounding, not a lift.
const expectSheetOnDock = (sheet, dock) =>
  expect(Math.abs(sheet.getBoundingClientRect().bottom - dock.getBoundingClientRect().top)).toBeLessThanOrEqual(1);

test("the Tools sheet uses its content height and stays above the dock", async () => {
  await page.viewport(390, 1200);
  mountWebappRoot();

  const sheet = await openMenuSheet();
  const project = navRow("Home", ".menu-sheet").closest(".nav-group");
  expect(project).not.toBeNull();
  const body = sheet.querySelector(".menu-sheet-body");
  const dock = document.querySelector(".dock");
  expect(sheet.getBoundingClientRect().top).toBeGreaterThan(100);
  expect(
    sheet.querySelector(".nav-group").getBoundingClientRect().top - sheet.getBoundingClientRect().top,
  ).toBeLessThan(24);
  expect(body.scrollHeight).toBe(body.clientHeight);
  expectSheetOnDock(sheet, dock);
  const start = {
    sheetHeight: sheet.getBoundingClientRect().height,
    projectTop: project.getBoundingClientRect().top,
  };

  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(sheet.getBoundingClientRect().height).toBeCloseTo(start.sheetHeight, 1);
  expect(project.getBoundingClientRect().top).toBeCloseTo(start.projectTop, 1);
  expect(sheet.querySelector(".guide-nav")).toBeNull();
  await page.viewport(390, 844);
  expect(sheet.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(body.scrollHeight).toBe(body.clientHeight);
  expectSheetOnDock(sheet, dock);
  await page.viewport(390, 420);
  expect(sheet.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  expectSheetOnDock(sheet, dock);
  await page.viewport(1280, 900);
});

test.each([320, 1280])("update prompt stays above page content at %ipx", async (width) => {
  const key = "rom-weaver-update-dismissed-build";
  const dismissed = localStorage.getItem(key);
  localStorage.removeItem(key);
  const onReloadUpdate = vi.fn();
  try {
    await page.viewport(width, 900);
    mountWebappRoot({ updateReady: true, onReloadUpdate });
    await expect.poll(() => document.querySelector(".app > .reveal.is-open > .update-ready")).toBeTruthy();
    const prompt = document.querySelector(".app > .reveal.is-open > .update-ready");
    expect(document.querySelector(".dock-runtime .updates, .desktop-runtime .updates")).toBeNull();
    expect(document.querySelector(".brand .sub-status")).toBeNull();
    expect(prompt.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(prompt.scrollWidth).toBeLessThanOrEqual(prompt.clientWidth);
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    expect(onReloadUpdate).toHaveBeenCalledTimes(1);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect
      .poll(
        () => document.querySelector(`${width < 1000 ? ".phone-runtime" : ".desktop-runtime"} .sub-status`)?.dataset.sw,
      )
      .toBe("update");
    await expect.poll(() => document.querySelector(".app > .reveal.is-open > .update-ready")).toBeNull();
  } finally {
    if (dismissed === null) localStorage.removeItem(key);
    else localStorage.setItem(key, dismissed);
  }
});
