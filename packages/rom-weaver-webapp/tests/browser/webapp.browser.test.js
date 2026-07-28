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
  await expect.element(page.getByRole("tab", { name: /docs/i })).toBeInTheDocument();
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

test("WebappRoot shows Docs by default while Trim and Tools stay behind the beta flag", async () => {
  mountWebappRoot();
  await expect
    .poll(() => [...document.querySelectorAll('.mode-rail [role="tab"]')].map((tab) => tab.textContent))
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
