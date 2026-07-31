import { createElement, useMemo } from "react";
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
});

const createServiceWorkerCacheState = () => ({
  label: "Offline cache unavailable",
  serviceWorkerStatus: null,
  title: "",
  updateLabel: "Reload to update",
  updateReady: false,
  updateTitle: "",
});

const createWebappState = (settings = getDefaultSettings()) => ({
  creatorSession: createEmptyCreatorSessionState(),
  currentView: "patcher",
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

function WebappRootHarness({ settings } = {}) {
  const props = useMemo(
    () => ({
      actions: createNoopActions(),
      confirmationDialog: createEmptyConfirmationDialogState(),
      pageUpdate: createEmptyPageUpdateState(),
      serviceWorkerCache: createServiceWorkerCacheState(),
      state: createWebappState(settings),
    }),
    [settings],
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
  // The Trim and Tools tabs are beta-gated (see `betaToolsEnabled`), so the full-shell assertions
  // below require the flag on - matching the pattern the sibling controller unit tests use.
  mountWebappRoot({ settings: { ...getDefaultSettings(), betaToolsEnabled: true } });

  // The unified drop surface is the only input now; its label flips once the workflow has files.
  const romInput = page.getByLabelText(/ROMs, patches, bundles, or archives/i);

  await expect.element(romInput).toBeInTheDocument();

  await expect.element(page.getByRole("tablist", { name: "Workflow" })).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: /weave/i })).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: /create/i })).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: /tools/i })).toBeInTheDocument();

  await romInput.upload(await loadFixtureFile(ONE_ROM_ZIP, "application/zip"));
  await selectCandidateIfPrompted("game.bin");

  await waitForInputStackFile("game.bin");
  await expect.element(page.getByText(CRC32_TEXT_REGEX)).toBeInTheDocument();
  // The output section (and its weave button) renders once the workflow has files.
  await expect.element(page.getByRole("button", { name: /weave & download/i })).toBeInTheDocument();

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

test("WebappRoot keeps Trim and Tools behind the beta flag and Guides in front of it", async () => {
  mountWebappRoot();
  // Docs is reference rather than a workflow, but it rides in the rail so the
  // readers it is written for do not have to go hunting for it.
  await expect
    .poll(() =>
      [...document.querySelectorAll('.mode-rail [role="tab"]')]
        .filter((tab) => getComputedStyle(tab).display !== "none")
        .map((tab) => tab.textContent),
    )
    .toEqual(["Weave", "Create", "Docs"]);
});

test("WebappRoot reports the configured thread count in the masthead, not the core count", async () => {
  // The masthead thread count must follow the Threads setting. It once called
  // resolveThreads() with no argument, so it always fell through to
  // navigator.hardwareConcurrency and a user who dialled threads down to 1
  // still read the host core count in the header.
  mountWebappRoot({ settings: { ...getDefaultSettings(), threads: 1 } });
  await expect.poll(() => document.querySelector(".masthead-threads-full")?.textContent || "").toContain("1 threads");
  await expect.poll(() => document.querySelector(".masthead-threads-short")?.textContent || "").toContain("1T");
});

test("WebappRoot uses the compact thread label only on mobile", async () => {
  page.viewport(1280, 900);
  mountWebappRoot({ settings: { ...getDefaultSettings(), threads: 10 } });
  await expect.poll(() => getComputedStyle(document.querySelector(".masthead-threads-full")).display).toBe("inline");
  await expect.poll(() => getComputedStyle(document.querySelector(".masthead-threads-short")).display).toBe("none");

  page.viewport(390, 844);
  await expect.poll(() => getComputedStyle(document.querySelector(".masthead-threads-full")).display).toBe("none");
  await expect.poll(() => getComputedStyle(document.querySelector(".masthead-threads-short")).display).toBe("inline");
  page.viewport(1280, 900);
});

test("the site footer lands inside the first phone screen with an empty bench", async () => {
  // The empty hero is sized as `100svh - --hero-chrome`, so every band the page
  // spends outside the hero has to be in that budget. The mobile scroll reserve
  // under the form was not, and it pushed the footer ~85px under the fold on
  // first paint. The narrowest phone is the tight case: the brand column wraps
  // there and the masthead grows taller than it is at 390px.
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
    page.viewport(width, height);
    mountWebappRoot();
    await expect.poll(() => document.querySelector(".step.is-input.is-empty .drop.hero")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".site-footer")?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(height);
  }
  page.viewport(1280, 900);
});

test("PWA side insets move footer content without shifting the shell", async () => {
  const safeLeft = 18;
  const safeRight = 18;
  const height = 852;
  page.viewport(393, height);
  mountWebappRoot();
  await expect.poll(() => document.querySelector(".site-footer")).toBeTruthy();
  const readLayout = () => {
    const masthead = document.querySelector(".masthead")?.getBoundingClientRect();
    const footer = document.querySelector(".site-footer")?.getBoundingClientRect();
    const links = document.querySelector(".site-footer-links")?.getBoundingClientRect();
    const status = document.querySelector(".site-footer-status")?.getBoundingClientRect();
    return {
      footerBottom: footer?.bottom ?? 0,
      footerTop: footer?.top ?? 0,
      linksLeft: links?.left ?? 0,
      mastheadTop: masthead?.top ?? 0,
      statusRight: status?.right ?? 0,
    };
  };
  const before = readLayout();
  const simulatedSafeArea = document.createElement("style");
  simulatedSafeArea.textContent = `.rw-app { --safe-l: ${safeLeft}px; --safe-r: ${safeRight}px; }`;
  document.head.append(simulatedSafeArea);
  try {
    const after = readLayout();
    expect(after.mastheadTop).toBe(before.mastheadTop);
    expect(after.footerTop).toBe(before.footerTop);
    expect(after.footerBottom).toBe(before.footerBottom);
    expect(after.linksLeft).toBeGreaterThan(before.linksLeft);
    expect(after.statusRight).toBeLessThan(before.statusRight);
  } finally {
    simulatedSafeArea.remove();
  }
  page.viewport(1280, 900);
});

test("the mobile scroll reserve returns once the bench holds a card", async () => {
  // The reserve keeps the last card clear of the phone browser's collapsing
  // bottom toolbar. It is only suppressed while the bench is empty; dropping
  // the suppression on a staged bench would hide the run/download slot again.
  page.viewport(390, 844);
  mountWebappRoot();
  const workflowBody = await waitForState(() => document.querySelector(".workflow-body"));
  expect(workflowBody).not.toBeNull();
  expect(getComputedStyle(workflowBody).paddingBlockEnd).toBe("0px");

  document.querySelector(".step.is-input.is-empty").classList.remove("is-empty");
  expect(getComputedStyle(workflowBody).paddingBlockEnd).toBe("96px");
  page.viewport(1280, 900);
});

test("the New here? beacon stays compact and its popover carries every start action", async () => {
  page.viewport(1024, 900);
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
  const pop = document.querySelector(".sample-tutorial-start-pop").getBoundingClientRect();
  expect(pop.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
  expect(pop.top).toBeGreaterThanOrEqual(0);

  page.viewport(360, 740);
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
      .poll(() => document.querySelector(".masthead-threads-full")?.textContent || "")
      .toContain(`${expected} threads`);
  } finally {
    Reflect.deleteProperty(navigator, "hardwareConcurrency");
    if (hardwareConcurrency) Object.defineProperty(Navigator.prototype, "hardwareConcurrency", hardwareConcurrency);
  }
});

test("WebappRoot keeps diagnostics out of the masthead - the Log dialog owns them", async () => {
  // The header stays theme / log / settings; the console-copy and mobile dev
  // tools toggles were folded into the Log dialog surface.
  mountWebappRoot();
  await expect.element(page.getByRole("button", { name: "Log" })).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Copy console logs" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Mobile dev tools" })).not.toBeInTheDocument();
});
