import { createElement, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { createEmptyPageUpdateState } from "../../src/webapp/page-update-state.ts";
import { getDefaultSettings } from "../../src/webapp/settings/settings-state.ts";
import { createEmptyConfirmationDialogState } from "../../src/webapp/webapp-layout.tsx";
import { WebappRoot } from "../../src/webapp/webapp-root.tsx";
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
    const selectedLabel =
      document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file")?.textContent || "";
    if (selectedLabel.includes(label)) return "selected";
    if (document.querySelector("#rom-weaver-candidate-selection-list")) return "dialog";
    return null;
  });
  expect(selectionState).not.toBeNull();
  if (selectionState === "selected") return;
  await page.getByRole("button", { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).click();
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
  onRestoreDefaults: () => undefined,
  onSaveClose: () => undefined,
  onSelectView: () => undefined,
});

const createServiceWorkerCacheState = () => ({
  label: "Offline cache unavailable",
  title: "",
  updateLabel: "Reload to update",
  updateReady: false,
  updateTitle: "",
});

const createWebappState = () => ({
  creatorSession: createEmptyCreatorSessionState(),
  currentView: "patcher",
  draftSettings: getDefaultSettings(),
  patcherSession: createEmptyPatcherSessionState(),
  settings: getDefaultSettings(),
  settingsDialogOpen: false,
  startup: {
    message: "",
    status: "ready",
  },
  validation: createEmptyValidationState(),
});

function WebappRootHarness() {
  const props = useMemo(
    () => ({
      actions: createNoopActions(),
      confirmationDialog: createEmptyConfirmationDialogState(),
      pageUpdate: createEmptyPageUpdateState(),
      serviceWorkerCache: createServiceWorkerCacheState(),
      state: createWebappState(),
    }),
    [],
  );
  return createElement(WebappRoot, props);
}

let mountedRoot = null;
let rootElement = null;

const mountWebappRoot = () => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  const root = createRoot(rootElement);
  root.render(createElement(WebappRootHarness));
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
  mountWebappRoot();

  const romInput = page.getByLabelText(/Select ROM/i);

  await expect.element(romInput).toBeInTheDocument();
  await expect.element(page.getByLabelText(/Select patch/i)).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: /apply patch/i })).toBeInTheDocument();

  await expect.element(page.getByRole("tablist", { name: "Workflow" })).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: /apply/i })).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: /create/i })).toBeInTheDocument();
  await expect.element(page.getByRole("contentinfo")).toBeInTheDocument();

  await romInput.upload(await loadFixtureFile(ONE_ROM_ZIP, "application/zip"));
  await selectCandidateIfPrompted("game.bin");

  await expect.element(page.getByText(/game\.bin/i)).toBeInTheDocument();
  await expect.element(page.getByText(CRC32_TEXT_REGEX)).toBeInTheDocument();

  await page.getByRole("button", { name: "Clear ROM input" }).click();
  await expect.element(page.getByText("game.bin", { exact: true })).not.toBeInTheDocument();

  await page.getByLabelText(/Select ROM/i).upload(await loadFixtureFile(MULTI_ROM_ZIP, "application/zip"));

  await selectCandidateIfPrompted("game.bin");

  await expect.element(page.getByText(/game\.bin/i)).toBeInTheDocument();
  await expect.element(page.getByText(CRC32_TEXT_REGEX)).toBeInTheDocument();
});
