import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { getActiveBrowserVirtualFiles } from "../../src/workers/protocol/browser-virtual-files.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const POSIX_DIRECTORY_PREFIX_REGEX = /^.*\//;
export const RAW_ROM = "tests/fixtures/archive_sources/game.bin";
export const RAW_PATCH = "tests/fixtures/archive_sources/change.ips";
export const ONE_PATCH_7Z = "tests/fixtures/archives/one-patch.7z";
export const MULTI_PATCH_ZIP = "tests/fixtures/archives/multi-patch.zip";
// Nested patch bundles: B_bundle = three nested zips with one patch each; C_root = a nested zip with
// two sibling patches plus a deeper nested patch; A_outer = a deep single-patch chain.
export const NESTED_BUNDLE_ZIP = "tests/fixtures/archives/B_bundle.zip";
export const NESTED_ROOT_ZIP = "tests/fixtures/archives/C_root.zip";
export const NESTED_CHAIN_ZIP = "tests/fixtures/archives/A_outer.zip";
export const MULTI_ROM_ZIP = "tests/fixtures/archives/multi-rom.zip";
export const RVZ_INPUT = "tests/fixtures/browser-generated/game.rvz";
export const CHD_INPUT = "tests/fixtures/browser-generated/game-cd.chd";
export const WRONG_INPUT_BPS = "tests/fixtures/browser-generated/wrong-input-same-size.bps";
export const VALID_BPS = "tests/fixtures/browser-generated/patch-matrix/raw/change.bps";
export const VALID_UPS = "tests/fixtures/browser-generated/patch-matrix/raw/change.ups";
export const ONE_ROM_ZIP = "tests/fixtures/archives/one-rom.zip";

let mountedRoot = null;

const getRoot = () => {
  const existing = document.getElementById("app");
  if (existing) return existing;
  const element = document.createElement("div");
  element.id = "app";
  document.body.appendChild(element);
  return element;
};

export const mount = (element) => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  const root = createRoot(getRoot());
  root.render(element);
  mountedRoot = root;
  return root;
};

export const createStaticController = (state, methods = {}) => ({
  getState: () => state,
  subscribe: () => () => undefined,
  ...methods,
});

const fileNameFromPath = (filePath) => filePath.replace(POSIX_DIRECTORY_PREFIX_REGEX, "");

// Cache raw bytes per path so repeated tests don't re-fetch the same fixture over HTTP.
const fixtureByteCache = new Map();

export const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  let bytes = fixtureByteCache.get(filePath);
  if (!bytes) {
    const response = await fetch(`/${filePath}`);
    if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
    bytes = await response.arrayBuffer();
    fixtureByteCache.set(filePath, bytes);
  }
  return new File([bytes], fileNameFromPath(filePath), { type });
};

export const selectFileInputs = (input, files) => {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  Object.defineProperty(input, "files", {
    configurable: true,
    value: dataTransfer.files,
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

export const selectFileInput = (input, file) => selectFileInputs(input, [file]);

export const createMockApplyResult = () => ({
  output: {
    cleanup: () => undefined,
    fileName: "game - change.bin",
    path: "",
    saveAs: () => Promise.resolve(),
    size: 4,
    vfs: {},
  },
  outputs: [],
  rom: {
    size: 4,
  },
  sizeSummary: {
    inputSize: 4,
    outputSize: 4,
    rawSize: 4,
  },
});

export const setFormControlValue = (element, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

export const waitForState = async (resolveState, timeout = 30000, intervalMs = 50) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = resolveState();
    if (state) return state;
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
  return null;
};

export const getRuntimeErrorText = () => document.getElementById("rom-weaver-error-message")?.textContent?.trim() || "";
const getOutputErrorText = () => document.getElementById("rom-weaver-output-notice-message")?.textContent?.trim() || "";
const getAnyErrorText = () => getRuntimeErrorText() || getOutputErrorText() || "";
// Staging failures surface in the per-section notices, not the runtime error element; selection
// helpers watch these too so a failed stage reports its message instead of timing out.
const getSectionNoticeText = () =>
  getRuntimeErrorText() ||
  document.getElementById("rom-weaver-patch-notice-message")?.textContent?.trim() ||
  document.getElementById("rom-weaver-input-notice-message")?.textContent?.trim() ||
  "";
const hasStagingProgress = () =>
  !!document.querySelector(
    "[id^='rom-weaver-progress-rom'], [id^='rom-weaver-progress-checksum'], [id^='rom-weaver-progress-patch']",
  );

export const waitForApplyButtonEnabled = async () => {
  try {
    await expect
      .poll(
        () =>
          document.getElementById("rom-weaver-button-apply") instanceof HTMLButtonElement &&
          !document.getElementById("rom-weaver-button-apply").disabled &&
          !hasStagingProgress(),
        { timeout: 30000 },
      )
      .toBe(true);
  } catch (error) {
    const notice = getSectionNoticeText();
    const applyButton = document.getElementById("rom-weaver-button-apply");
    const progress = [...document.querySelectorAll("[id^='rom-weaver-progress-']")]
      .map((element) => `${element.id}=${element.textContent?.trim() || ""}`)
      .join(", ");
    const details = [
      notice && `notice=${notice}`,
      `button=${applyButton?.textContent?.trim() || "missing"}`,
      `disabled=${applyButton instanceof HTMLButtonElement ? String(applyButton.disabled) : "n/a"}`,
      `input=${getInputStackFileName() || "missing"}`,
      `patches=${getPatchStackFileNames().join(",") || "missing"}`,
      `output=${getOutputFileNameValue() || "missing"}`,
      progress && `progress=${progress}`,
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`Apply did not become ready (${details})`, { cause: error });
  }
};

export const clickApplyButton = async () => {
  const clicked = await waitForState(() => {
    const applyButton = document.getElementById("rom-weaver-button-apply");
    if (!(applyButton instanceof HTMLButtonElement) || applyButton.disabled) return null;
    applyButton.click();
    return true;
  }, 30000);
  expect(clicked).toBe(true);
};

export const waitForApplyOutcome = async () => {
  return waitForState(() => {
    const applyButton = document.getElementById("rom-weaver-button-apply");
    const errorText = getAnyErrorText();
    if (errorText) return { errorText, kind: "error" };
    if (!(applyButton instanceof HTMLButtonElement)) return null;
    const isDownloadReady = !applyButton.disabled && (applyButton.textContent || "").includes("Download");
    if (isDownloadReady) return { kind: "download" };
    const canTriggerApply = !applyButton.disabled && (applyButton.textContent || "").toLowerCase().includes("weave");
    if (canTriggerApply && !hasStagingProgress()) applyButton.click();
    return null;
  }, 60000);
};

export const getCandidateSelectionList = () => document.querySelector(".rw-modal.select-modal .seltree");
export const getCandidateSelectionCloseButton = () =>
  document.querySelector(".rw-modal.select-modal .modal-head button[aria-label='Close']");
export const getInputStackRows = () => Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .file"));
export const getPatchStackRows = () => Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .file"));
// One patch row = one `.rom-weaver-patch-stack-file` label; read its primary file name (the
// direct-child <strong>). A nested patch also renders a second <strong> inside the archive-path
// span, so match only direct children to avoid double-counting rows that have an extract section.
export const getPatchStackFileNames = () =>
  Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file > strong"))
    .map((entry) => entry.textContent?.trim() || "")
    .filter(Boolean);

export const clickCandidateSelectionOption = async (label) => {
  const state = await waitForState(() => {
    const list = getCandidateSelectionList();
    if (list) return { kind: "dialog" };
    const selectedLabel = document.querySelector(
      "#rom-weaver-list-input-stack .rom-weaver-input-stack-file",
    )?.textContent;
    if (selectedLabel?.includes(label)) return { kind: "selected" };
    const errorText = getSectionNoticeText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(state).not.toBeNull();
  expect(state?.kind, state && "errorText" in state ? state.errorText : "").not.toBe("error");
  if (state?.kind === "selected") return;
  if (!getCandidateSelectionList()) return;
  // An ambiguous multi-entry archive (e.g. multiple distinct ROM payloads) renders as a
  // multi-select checklist. Pick the single requested entry by ticking its checkbox and confirming;
  // the result is still one chosen input. A genuinely single-select prompt renders the tree instead.
  const checklistRow = Array.from(document.querySelectorAll(".rw-modal.select-modal .seltree .selcheck")).find(
    (entry) => entry.textContent?.includes(label),
  );
  if (checklistRow) {
    const checkbox = checklistRow.querySelector("input[type='checkbox']");
    if (checkbox && !checkbox.checked) checkbox.click();
    const confirm = document.querySelector(".rw-modal.select-modal .selconfirm");
    if (!confirm) throw new Error("Missing candidate selection confirm button");
    confirm.click();
    return;
  }
  const button = Array.from(
    document.querySelectorAll(
      ".rw-modal.select-modal .seltree button, .rw-modal.select-modal .seltree [role='button']",
    ),
  ).find((entry) => entry.textContent?.includes(label));
  if (!button) throw new Error(`Missing candidate selection option: ${label}`);
  button.click();
};

// The patch candidate dialog is a multi-select checklist: tick each requested row's checkbox, then
// click the confirm button. Passing one label adds a single patch (mirrors the old single-select).
export const selectPatchCandidates = async (labels) => {
  const firstLabel = labels[0];
  const state = await waitForState(() => {
    const list = getCandidateSelectionList();
    if (list) return { kind: "dialog" };
    // A new upload can briefly leave the previous selected row visible while its replacement is
    // still being staged. Do not mistake that stale row for the new selection.
    if (hasStagingProgress()) return null;
    const patchFileName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file")?.textContent || "";
    const selectedPatchName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "";
    if (selectedPatchName.includes(firstLabel) || patchFileName === firstLabel) return { kind: "selected" };
    const errorText = getSectionNoticeText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(state).not.toBeNull();
  expect(state?.kind, state && "errorText" in state ? state.errorText : "").not.toBe("error");
  if (state?.kind === "selected") return;
  if (!getCandidateSelectionList()) return;
  const rows = Array.from(document.querySelectorAll(".rw-modal.select-modal .seltree .selcheck"));
  for (const label of labels) {
    const row = rows.find((entry) => entry.textContent?.includes(label));
    if (!row) throw new Error(`Missing patch candidate selection option: ${label}`);
    const checkbox = row.querySelector("input[type='checkbox']");
    if (checkbox && !checkbox.checked) checkbox.click();
  }
  const confirm = document.querySelector(".rw-modal.select-modal .selconfirm");
  if (!confirm) throw new Error("Missing patch candidate confirm button");
  confirm.click();
};

export const clickPatchCandidateSelectionOption = async (label) => selectPatchCandidates([label]);

export const getInputStackFileName = () => {
  const candidates = Array.from(
    document.querySelectorAll("#rom-weaver-list-input-stack .rom-weaver-input-stack-file > strong"),
  )
    .map((entry) => entry.textContent?.trim() || "")
    .filter(Boolean);
  return (
    candidates.find((entry) => /^[^<>:"|?*\n\r]+?\.[a-z0-9]{2,5}$/i.test(entry)) ||
    candidates.find((entry) => /\.[a-z0-9]{2,5}\b/i.test(entry)) ||
    candidates.find((entry) => !/^\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)$/i.test(entry)) ||
    ""
  );
};
export const getOutputFileNameValue = () => document.getElementById("rom-weaver-input-output-file-name")?.value || "";

export const waitForInputStackFileName = async () => {
  const state = await waitForState(() => {
    if (hasStagingProgress()) return null;
    const fileName = getInputStackFileName();
    const trimmedName = fileName?.trim() || "";
    if (trimmedName && !/^\(\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)\)$/i.test(trimmedName)) {
      return { fileName: trimmedName, kind: "ready" };
    }
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(state).not.toBeNull();
  expect(state?.kind, state && "errorText" in state ? state.errorText : "").toBe("ready");
  return state?.fileName || "";
};

export const clearOpfsInputDirectory = async () => {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  // Removals fail (silently) while a worker still holds a sync access handle on an entry, and a
  // leftover file makes the next test's extraction collide and drop outputs. Verify the directory
  // actually emptied and retry briefly so handle releases from a just-terminated worker can land.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let remaining = 0;
    for await (const [name] of root.entries()) {
      if (name === ".rom-weaver-opfs-scratch") continue;
      remaining += 1;
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    if (!remaining) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
};

export const clearOpfsOutputDirectory = async () => {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    for await (const [name] of root.entries()) {
      if (name === ".rom-weaver-opfs-scratch") continue;
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    if (!(await listOpfsOutputFiles().catch(() => [])).length) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
};

const listOpfsWorkFiles = async () => {
  if (!navigator.storage?.getDirectory) return [];
  const root = await navigator.storage.getDirectory();
  const files = [];
  const walk = async (dirHandle, prefix) => {
    for await (const [name, handle] of dirHandle.entries()) {
      if (name === ".rom-weaver-opfs-scratch") continue;
      const nextPath = `${prefix}/${name}`;
      if (handle.kind === "file") {
        const file = await handle.getFile().catch(() => null);
        if (file) {
          files.push({
            name,
            path: nextPath,
            size: file.size,
          });
        }
        continue;
      }
      await walk(handle, nextPath).catch(() => undefined);
    }
  };
  await walk(root, "work");
  return files;
};

const listOpfsInputFiles = listOpfsWorkFiles;

export const listOpfsInputFilesMatching = async (fragment) => {
  const files = await listOpfsInputFiles();
  return files.filter((entry) => entry.path.includes(fragment));
};

export const listOpfsStagedInputSourceFiles = async (fragment = "") => {
  const files = await listOpfsInputFiles();
  return files.filter(
    (entry) => entry.path.includes(fragment) && /(?:chd-input|chd-track|rvz-input|z3ds-input)/.test(entry.path),
  );
};

export const listOpfsOutputFiles = async () => {
  const files = await listOpfsWorkFiles();
  return files.filter((entry) => entry.name === "game - change" || /^game - change\.(?:7z|bin|zip)$/i.test(entry.name));
};

export const installPatcherTestHooks = () => {
  beforeEach(async () => {
    mountedRoot?.unmount?.();
    mountedRoot = null;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 40));
    // Virtual File-backed sources are intentionally retained briefly for sequential workflow passes.
    // A new test must release that cache explicitly or the old guest name can force an extracted
    // output to become `name-2.ext`.
    const retainedSources = getActiveBrowserVirtualFiles()
      .map((entry) => entry.source)
      .filter((source) => source !== undefined);
    await browserRuntime.workerIo.releaseSources?.(retainedSources);
    // Reset the runner BEFORE clearing OPFS: the previous test's worker holds sync access handles
    // on extracted files, and removals silently fail while those are open. Terminating first lets
    // the clear actually empty the directory.
    await resetRomWeaverRunner();
    await clearOpfsInputDirectory();
    await warmupRomWeaverRunner();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    // A previous test may have left a routing hash behind; a fresh mount must
    // not inherit it.
    if (globalThis.location.hash) {
      globalThis.history.replaceState(
        globalThis.history.state,
        "",
        globalThis.location.pathname + globalThis.location.search,
      );
    }
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(async () => {
    mountedRoot?.unmount?.();
    mountedRoot = null;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  });
};
