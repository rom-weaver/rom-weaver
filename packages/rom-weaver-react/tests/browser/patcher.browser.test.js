import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { PatcherPrimaryAction } from "../../src/public/react/components/patcher-output-controls.tsx";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  inertDialogController,
  inertOutputController,
  inertStackController,
  useLocalApplyPatchFormSession,
} from "../../src/public/react/patcher-form-session.ts";
import { createEmptyPatcherOutputState } from "../../src/public/react/patcher-presentation.ts";
import { createEmptyPatcherUiState } from "../../src/public/react/patcher-ui-state.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const POSIX_DIRECTORY_PREFIX_REGEX = /^.*\//;
const RAW_ROM = "tests/fixtures/archive_sources/game.bin";
const RAW_PATCH = "tests/fixtures/archive_sources/change.ips";
const ONE_PATCH_7Z = "tests/fixtures/archives/one-patch.7z";
const MULTI_PATCH_ZIP = "tests/fixtures/archives/multi-patch.zip";
const MULTI_ROM_ZIP = "tests/fixtures/archives/multi-rom.zip";
const RVZ_INPUT = "tests/fixtures/browser-generated/game.rvz";
const CHD_INPUT = "tests/fixtures/browser-generated/game-cd.chd";
const WRONG_INPUT_BPS = "tests/fixtures/browser-generated/wrong-input-same-size.bps";
const VALID_BPS = "tests/fixtures/browser-generated/patch-matrix/raw/change.bps";
const VALID_UPS = "tests/fixtures/browser-generated/patch-matrix/raw/change.ups";
const ONE_ROM_ZIP = "tests/fixtures/archives/one-rom.zip";

let mountedRoot = null;

const getRoot = () => {
  const existing = document.getElementById("app");
  if (existing) return existing;
  const element = document.createElement("div");
  element.id = "app";
  document.body.appendChild(element);
  return element;
};

const mount = (element) => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  const root = createRoot(getRoot());
  root.render(element);
  mountedRoot = root;
  return root;
};

const createStaticController = (state, methods = {}) => ({
  getState: () => state,
  subscribe: () => () => undefined,
  ...methods,
});

const createRomInputRowState = (overrides = {}) => {
  const emptyState = createEmptyPatcherUiState();
  const { info: infoOverrides = {}, ...rowOverrides } = overrides;
  return {
    ...emptyState.romInput,
    disabled: false,
    groupId: "",
    id: "rom-input-1",
    info: {
      archiveName: "",
      checksumsExpanded: true,
      checksumTiming: "",
      crc32: "",
      fileName: "game.nds",
      md5: "",
      romInfo: "",
      sha1: "",
      validationPhase: "idle",
      ...infoOverrides,
    },
    kind: "rom",
    loading: false,
    order: 0,
    valid: true,
    ...rowOverrides,
  };
};

const fileNameFromPath = (filePath) => filePath.replace(POSIX_DIRECTORY_PREFIX_REGEX, "");

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  const bytes = await response.arrayBuffer();
  return new File([bytes], fileNameFromPath(filePath), { type });
};

const selectFileInputs = (input, files) => {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  Object.defineProperty(input, "files", {
    configurable: true,
    value: dataTransfer.files,
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const selectFileInput = (input, file) => selectFileInputs(input, [file]);

const createMockApplyResult = () => ({
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

const setFormControlValue = (element, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

const waitForState = async (resolveState, timeout = 30000, intervalMs = 50) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = resolveState();
    if (state) return state;
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
  return null;
};

const getRuntimeErrorText = () => document.getElementById("rom-weaver-error-message")?.textContent?.trim() || "";
const getOutputErrorText = () => document.getElementById("rom-weaver-output-notice-message")?.textContent?.trim() || "";
const getAnyErrorText = () => getRuntimeErrorText() || getOutputErrorText() || "";
const hasStagingProgress = () =>
  !!document.querySelector(
    "[id^='rom-weaver-progress-rom'], [id^='rom-weaver-progress-checksum'], [id^='rom-weaver-progress-patch']",
  );

const waitForApplyButtonEnabled = async () => {
  await expect
    .poll(
      () =>
        document.getElementById("rom-weaver-button-apply") instanceof HTMLButtonElement &&
        !document.getElementById("rom-weaver-button-apply").disabled &&
        !hasStagingProgress(),
      { timeout: 30000 },
    )
    .toBe(true);
};

const clickApplyButton = async () => {
  const clicked = await waitForState(() => {
    const applyButton = document.getElementById("rom-weaver-button-apply");
    if (!(applyButton instanceof HTMLButtonElement) || applyButton.disabled) return null;
    applyButton.click();
    return true;
  }, 30000);
  expect(clicked).toBe(true);
};

const waitForApplyOutcome = async () => {
  return waitForState(() => {
    const applyButton = document.getElementById("rom-weaver-button-apply");
    const errorText = getAnyErrorText();
    if (errorText) return { errorText, kind: "error" };
    if (!(applyButton instanceof HTMLButtonElement)) return null;
    const isDownloadReady = !applyButton.disabled && (applyButton.textContent || "").includes("Download");
    if (isDownloadReady) return { kind: "download" };
    const canTriggerApply =
      !applyButton.disabled && (applyButton.textContent || "").toLowerCase().includes("apply patch");
    if (canTriggerApply && !hasStagingProgress()) applyButton.click();
    return null;
  }, 60000);
};

const createChecksumOverrideHarnessElement = (applyPatchesSpy, stagedPatchInfoOverrides = {}) => {
  const inputFile = new File([new Uint8Array([0, 1, 2, 3])], "game.bin", {
    type: "application/octet-stream",
  });
  const patchFile = new File([new Uint8Array([0x42, 0x50, 0x53, 0x31])], "change.bps", {
    type: "application/octet-stream",
  });
  const stagedInputInfo = {
    checksums: {
      crc32: "00000000",
      md5: "d41d8cd98f00b204e9800998ecf8427e",
      sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    },
    fileName: "game.bin",
    id: "input-1",
    order: 0,
    parentCompressions: [
      {
        decompressionTimeMs: 5,
        fileName: "roms.zip",
        outputSize: 4096,
        sourceSize: 8192,
      },
    ],
    size: 4096,
    sourceSize: 4096,
  };
  const stagedPatchInfo = {
    checksumPreflightMismatch: true,
    fileName: "change.bps",
    id: "patch-1",
    order: 0,
    parentCompressions: [
      {
        decompressionTimeMs: 7,
        fileName: "patches.7z",
        outputSize: 4096,
        sourceSize: 16384,
      },
    ],
    size: 4096,
    sourceSize: 4096,
    targetLabel: "Target: game.bin",
    validationActualValue: "size=4 B, crc32=00000000",
    validationLabel: "Expected",
    validationMessage: "Actual input",
    validationState: "invalid",
    validationValues: ["size=4.10 KB (4096 B)", "min_size=1.02 KB (1024 B)", "crc32=deadbeef"],
    ...stagedPatchInfoOverrides,
  };
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches: applyPatchesSpy,
        applyReady: true,
        defaultSettings: {
          output: {
            compression: "none",
          },
          validation: {
            requireInputChecksumMatch: true,
          },
        },
        downloadOutput: () => undefined,
        inputs: [inputFile],
        patches: [patchFile],
        stageInput: async (_snapshot, handlers) => {
          handlers.onState(stagedInputInfo);
          handlers.onChecksum(stagedInputInfo);
          return [stagedInputInfo];
        },
        stagePatches: async () => [stagedPatchInfo],
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };
  return createElement(Harness);
};

const getCandidateSelectionList = () => document.querySelector(".rw-modal.select-modal .seltree");
const getCandidateSelectionCloseButton = () =>
  document.querySelector(".rw-modal.select-modal .modal-head button[aria-label='Close']");
const getInputStackRows = () => Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .file"));
const getPatchStackRows = () => Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .file"));

const clickCandidateSelectionOption = async (label) => {
  const state = await waitForState(() => {
    const list = getCandidateSelectionList();
    if (list) return { kind: "dialog" };
    const selectedLabel = document.querySelector(
      "#rom-weaver-list-input-stack .rom-weaver-input-stack-file",
    )?.textContent;
    if (selectedLabel?.includes(label)) return { kind: "selected" };
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(state).not.toBeNull();
  expect(state?.kind, state && "errorText" in state ? state.errorText : "").not.toBe("error");
  if (state?.kind === "selected") return;
  if (!getCandidateSelectionList()) return;
  const button = Array.from(
    document.querySelectorAll(
      ".rw-modal.select-modal .seltree button, .rw-modal.select-modal .seltree [role='button']",
    ),
  ).find((entry) => entry.textContent?.includes(label));
  if (!button) throw new Error(`Missing candidate selection option: ${label}`);
  button.click();
};

const clickPatchCandidateSelectionOption = async (label) => {
  const state = await waitForState(() => {
    const patchFileName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file")?.textContent || "";
    const selectedPatchName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "";
    if (selectedPatchName.includes(label) || patchFileName === label) return { kind: "selected" };
    const list = getCandidateSelectionList();
    if (list) return { kind: "dialog" };
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(state).not.toBeNull();
  expect(state?.kind, state && "errorText" in state ? state.errorText : "").not.toBe("error");
  if (state?.kind === "selected") return;
  if (!getCandidateSelectionList()) return;
  const button = Array.from(
    document.querySelectorAll(
      ".rw-modal.select-modal .seltree button, .rw-modal.select-modal .seltree [role='button']",
    ),
  ).find((entry) => entry.textContent?.includes(label));
  if (!button) throw new Error(`Missing patch candidate selection option: ${label}`);
  button.click();
};

const getInputStackFileName = () => {
  const candidates = Array.from(
    document.querySelectorAll(
      "#rom-weaver-list-input-stack .file .file-name > .chain .lvl.last .fn, #rom-weaver-list-input-stack .rom-weaver-input-stack-file strong",
    ),
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
const getOutputFileNameValue = () => document.getElementById("rom-weaver-input-output-file-name")?.value || "";

const waitForInputStackFileName = async () => {
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

const clearOpfsInputDirectory = async () => {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries()) {
    if (name === ".rom-weaver-opfs-scratch") continue;
    await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  }
};

const clearOpfsOutputDirectory = async () => {
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

const listOpfsInputFilesMatching = async (fragment) => {
  const files = await listOpfsInputFiles();
  return files.filter((entry) => entry.path.includes(fragment));
};

const listOpfsStagedInputSourceFiles = async (fragment = "") => {
  const files = await listOpfsInputFiles();
  return files.filter(
    (entry) => entry.path.includes(fragment) && /(?:chd-input|chd-track|rvz-input|z3ds-input)/.test(entry.path),
  );
};

const listOpfsOutputFiles = async () => {
  const files = await listOpfsWorkFiles();
  return files.filter((entry) => entry.name === "game - change" || /^game - change\.(?:7z|bin|zip)$/i.test(entry.name));
};

beforeEach(async () => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  await new Promise((resolve) => globalThis.setTimeout(resolve, 40));
  await clearOpfsInputDirectory();
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(async () => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
});

test("apply progress cancel button invokes primary cancel without visible cancel text", async () => {
  const cancelPrimaryAction = vi.fn();
  const runPrimaryAction = vi.fn();
  const state = {
    applyButton: {
      disabled: false,
      label: "Apply patch",
      loading: true,
      progress: {
        message: "Applying patch...",
        percent: null,
      },
    },
  };

  mount(
    createElement(PatcherPrimaryAction, {
      controller: {
        cancelPrimaryAction,
        getState: () => state,
        runPrimaryAction,
        subscribe: () => () => undefined,
      },
    }),
  );

  await expect
    .poll(() => document.querySelector("button[aria-label='Cancel apply']") instanceof HTMLButtonElement)
    .toBe(true);
  const cancelButton = document.querySelector("button[aria-label='Cancel apply']");
  expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
  expect(cancelButton.textContent).toBe("");
  cancelButton.click();

  expect(cancelPrimaryAction).toHaveBeenCalledTimes(1);
  expect(runPrimaryAction).not.toHaveBeenCalled();
});

test("cancelling active apply clears apply-time extraction progress without rerunning", async () => {
  const inputFile = new File([new Uint8Array([0, 1, 2, 3])], "game.bin", {
    type: "application/octet-stream",
  });
  const stagedInputInfo = {
    fileName: "game.bin",
    id: "input-1",
    order: 0,
    size: 4,
    sourceSize: 4,
  };
  const applyPatches = vi.fn(async ({ options }) => {
    options.onProgress?.({
      details: {
        fileName: "game.bin",
        order: 0,
        role: "input",
        sourceId: "input-1",
        stage: "input",
      },
      hasProgress: true,
      label: "Extracting game.bin...",
      message: "Extracting game.bin...",
      percent: null,
      role: "input",
      stage: "input",
    });
    await new Promise((_resolve, reject) => {
      const rejectCancelled = () => reject(Object.assign(new Error("Workflow was cancelled"), { code: "CANCELLED" }));
      if (options.signal?.aborted) {
        rejectCancelled();
        return;
      }
      options.signal?.addEventListener("abort", rejectCancelled, { once: true });
    });
  });
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches,
        applyReady: true,
        downloadOutput: () => undefined,
        inputs: [inputFile],
        patches: [],
        stageInput: async (_snapshot, handlers) => {
          handlers.onState(stagedInputInfo);
          return [stagedInputInfo];
        },
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  mount(createElement(Harness));

  await waitForApplyButtonEnabled();
  await clickApplyButton();
  await expect.poll(() => applyPatches.mock.calls.length).toBe(1);
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-input-stack .fileprog")?.textContent || "")
    .toContain("Extracting game.bin");

  const cancelButton = document.querySelector("button[aria-label='Cancel apply']");
  expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
  cancelButton.click();

  await expect.poll(() => document.querySelector("#rom-weaver-list-input-stack .fileprog")).toBeNull();
  await expect
    .poll(() => {
      const applyButton = document.getElementById("rom-weaver-button-apply");
      return (
        applyButton instanceof HTMLButtonElement &&
        !applyButton.disabled &&
        /apply/i.test(applyButton.textContent || "")
      );
    })
    .toBe(true);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  expect(applyPatches).toHaveBeenCalledTimes(1);
});

test("ApplyPatchForm runs a complete patch flow and downloads output", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        output: {
          compression: "none",
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();

  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply")?.textContent || "", { timeout: 30000 })
    .toContain("Download");
  expect(document.getElementById("rom-weaver-error-message")?.textContent || "").toBe("");
});

test("manual output name is used for patchless apply download", async () => {
  const downloadNames = [];
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    downloadNames.push(this.download || "");
    return originalAnchorClick.apply(this, args);
  };
  try {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: {
          output: {
            compression: "none",
          },
        },
      }),
    );

    await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

    selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
    setFormControlValue(document.getElementById("rom-weaver-input-output-file-name"), "custom-output");

    await waitForApplyButtonEnabled();
    await clickApplyButton();

    const applyState = await waitForApplyOutcome();
    expect(applyState).not.toBeNull();
    expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
    expect(downloadNames.at(-1)).toBe("custom-output.bin");
  } finally {
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
});

test("removing a patch refreshes generated output name", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        output: {
          compression: "none",
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await expect.poll(getOutputFileNameValue, { timeout: 30000 }).toBe("game - change");

  const removePatchButton = document.querySelector("button[aria-label='Remove patch']");
  if (!(removePatchButton instanceof HTMLButtonElement)) throw new Error("Missing remove patch button");
  removePatchButton.click();

  await expect.poll(getOutputFileNameValue, { timeout: 30000 }).toBe("game.bin");
});

test("removing an input refreshes generated output name", async () => {
  const firstInput = await loadFixtureFile(RAW_ROM);
  const secondInput = new File([await firstInput.arrayBuffer()], "second.bin", { type: firstInput.type });
  const stageInput = vi.fn(async (snapshot) =>
    snapshot.inputs.map((input, index) => ({
      fileName: input.name || `input-${index + 1}.bin`,
      id: `input-${index + 1}`,
      order: index,
      size: input.size,
      sourceSize: input.size,
    })),
  );
  const Harness = () => {
    const [inputs, setInputs] = useState([firstInput, secondInput]);
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches: vi.fn(async () => createMockApplyResult()),
        applyReady: true,
        defaultSettings: {
          defaultCompression: "auto",
        },
        downloadOutput: () => undefined,
        inputs,
        onInputsChange: setInputs,
        patches: [],
        stageInput,
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  mount(createElement(Harness));

  await expect
    .poll(() => document.querySelectorAll("#rom-weaver-list-input-stack .rom-weaver-input-stack-file").length, {
      timeout: 30000,
    })
    .toBe(2);
  await expect.poll(getOutputFileNameValue, { timeout: 30000 }).toBe("game.bin");

  const removeInputButton = document.querySelector("button[aria-label='Remove ROM input']");
  if (!(removeInputButton instanceof HTMLButtonElement)) throw new Error("Missing remove ROM input button");
  removeInputButton.click();

  await expect.poll(getOutputFileNameValue, { timeout: 30000 }).toBe("second.bin");
});

test("editing output name after download is ready keeps the prepared output", async () => {
  const downloadNames = [];
  const downloadBlobTypes = [];
  let applyCompleteCount = 0;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const originalCreateObjectUrl = URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function (...args) {
    downloadNames.push(this.download || "");
    return originalAnchorClick.apply(this, args);
  };
  URL.createObjectURL = function (blob) {
    downloadBlobTypes.push(blob instanceof Blob ? blob.type : "");
    return originalCreateObjectUrl.call(this, blob);
  };
  try {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: {
          output: {
            compression: "none",
          },
        },
        onApplyComplete: () => {
          applyCompleteCount += 1;
        },
      }),
    );

    await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

    selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
    selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(RAW_PATCH));

    await waitForApplyButtonEnabled();
    await clickApplyButton();

    const applyState = await waitForApplyOutcome();
    expect(applyState).not.toBeNull();
    expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
    expect(applyCompleteCount).toBe(1);

    setFormControlValue(document.getElementById("rom-weaver-input-output-file-name"), "renamed-output");

    await expect
      .poll(() => document.getElementById("rom-weaver-button-apply")?.textContent || "", { timeout: 30000 })
      .toContain("Download");

    await clickApplyButton();

    expect(downloadNames.at(-1)).toBe("renamed-output.bin");
    expect(downloadBlobTypes.at(-1)).toBe("application/octet-stream");
    expect(applyCompleteCount).toBe(1);
  } finally {
    HTMLAnchorElement.prototype.click = originalAnchorClick;
    URL.createObjectURL = originalCreateObjectUrl;
  }
});

test("changing output format invalidates pending download and removes OPFS output", async () => {
  await clearOpfsOutputDirectory();
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        output: {
          compression: "none",
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
  await expect.poll(async () => (await listOpfsOutputFiles()).length, { timeout: 30000 }).toBeGreaterThan(0);

  setFormControlValue(document.getElementById("rom-weaver-select-output-format"), "zip");

  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply")?.textContent || "", { timeout: 30000 })
    .toContain("Apply");
  await expect.poll(async () => (await listOpfsOutputFiles()).length, { timeout: 30000 }).toBe(0);
});

test("changing output format reuses prepared archived input on next apply", async () => {
  const logs = [];
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        logging: {
          level: "trace",
          sink: (record) => logs.push(record),
        },
        output: {
          compression: "none",
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(ONE_ROM_ZIP));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const firstApplyState = await waitForApplyOutcome();
  expect(firstApplyState).not.toBeNull();
  expect(
    firstApplyState?.kind,
    firstApplyState && "errorText" in firstApplyState ? firstApplyState.errorText : "",
  ).toBe("download");

  const logStart = logs.length;
  setFormControlValue(document.getElementById("rom-weaver-select-output-format"), "zip");
  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const secondApplyState = await waitForApplyOutcome();
  expect(secondApplyState).not.toBeNull();
  expect(
    secondApplyState?.kind,
    secondApplyState && "errorText" in secondApplyState ? secondApplyState.errorText : "",
  ).toBe("download");

  const secondApplyLogs = logs.slice(logStart);
  expect(
    secondApplyLogs.some(
      (record) => record.namespace === "react:apply-workflow" && record.message === "prepareWorkflow setInput start",
    ),
  ).toBe(false);
  expect(
    secondApplyLogs.some(
      (record) =>
        record.namespace === "workflow:apply" &&
        record.message === "stage.skip" &&
        record.details?.stage === "input.prepare" &&
        record.details?.reason === "prepared input assets supplied",
    ),
  ).toBe(true);
});

test("changing patch after completion reuses prepared archived input on next apply", async () => {
  const logs = [];
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        logging: {
          level: "trace",
          sink: (record) => logs.push(record),
        },
        output: {
          compression: "none",
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(ONE_ROM_ZIP));
  const initialPatch = await loadFixtureFile(RAW_PATCH);
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), initialPatch);

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const firstApplyState = await waitForApplyOutcome();
  expect(
    firstApplyState?.kind,
    firstApplyState && "errorText" in firstApplyState ? firstApplyState.errorText : "",
  ).toBe("download");

  const replacementPatch = new File([await initialPatch.arrayBuffer()], "change-v2.ips", {
    type: "application/octet-stream",
  });
  const logStart = logs.length;
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), replacementPatch);
  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const secondApplyState = await waitForApplyOutcome();
  expect(
    secondApplyState?.kind,
    secondApplyState && "errorText" in secondApplyState ? secondApplyState.errorText : "",
  ).toBe("download");

  const secondApplyLogs = logs.slice(logStart);
  expect(
    secondApplyLogs.some(
      (record) => record.namespace === "react:apply-workflow" && record.message === "prepareWorkflow setInput start",
    ),
  ).toBe(false);
  expect(
    secondApplyLogs.some(
      (record) =>
        record.namespace === "workflow:apply" &&
        record.message === "stage.skip" &&
        record.details?.stage === "input.prepare" &&
        record.details?.reason === "prepared input assets supplied",
    ),
  ).toBe(true);
});

test("compressed outputs clean up intermediate raw OPFS files", async () => {
  await clearOpfsOutputDirectory();
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        output: {
          compression: "zip",
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");

  const outputFiles = await listOpfsOutputFiles();
  expect(outputFiles.some((entry) => /\.zip$/i.test(entry.name))).toBe(true);
  expect(outputFiles.some((entry) => entry.name === "game - change")).toBe(false);
});

test("candidate selection resolves multi-entry archive inputs", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-rom"),
    await loadFixtureFile(MULTI_ROM_ZIP, "application/zip"),
  );

  await clickCandidateSelectionOption("game.bin");

  await expect
    .poll(
      () => document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file")?.textContent || "",
      { timeout: 30000 },
    )
    .toMatch(/\S+/);
});

test("clearing ROM input releases extracted OPFS files", async () => {
  await clearOpfsInputDirectory();
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-rom"),
    await loadFixtureFile(MULTI_ROM_ZIP, "application/zip"),
  );

  await clickCandidateSelectionOption("game.bin");
  await waitForInputStackFileName();

  const clearButton = document.querySelector("button[title='Clear ROM input'], button[title='Remove ROM input']");
  if (!(clearButton instanceof HTMLButtonElement)) throw new Error("Missing clear or remove ROM input button");
  clearButton.click();

  await expect
    .poll(() => !document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file"), {
      timeout: 30000,
    })
    .toBe(true);
  await expect.poll(async () => (await listOpfsInputFilesMatching("multi-rom")).length, { timeout: 30000 }).toBe(0);
});

test("clearing CHD ROM input does not leave staged OPFS source files", async () => {
  await clearOpfsInputDirectory();
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(CHD_INPUT));
  await waitForInputStackFileName();

  expect(await listOpfsStagedInputSourceFiles("game-cd.chd")).toEqual([]);

  const clearButton = document.querySelector("button[title='Clear ROM input'], button[title='Remove ROM input']");
  if (!(clearButton instanceof HTMLButtonElement)) throw new Error("Missing clear or remove ROM input button");
  clearButton.click();

  await expect
    .poll(() => !document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file"), {
      timeout: 30000,
    })
    .toBe(true);
  await expect
    .poll(async () => (await listOpfsStagedInputSourceFiles("game-cd")).length, { interval: 50, timeout: 3000 })
    .toBe(0);
});

test("direct CUE plus BIN upload hides CUE row checksums", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();
  expect(document.getElementById("rom-weaver-input-file-rom")?.multiple).toBe(false);

  const rawInput = await loadFixtureFile(RAW_ROM);
  const binFile = new File([await rawInput.arrayBuffer()], "direct-disc.bin", { type: "application/octet-stream" });
  const cueFile = new File(
    ['FILE "direct-disc.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n'],
    "direct-disc.cue",
    { type: "application/x-cue" },
  );

  selectFileInputs(document.getElementById("rom-weaver-input-file-rom"), [cueFile, binFile]);

  const getRows = () => getInputStackRows();
  const getRow = (fileName) => getRows().find((row) => row.textContent?.includes(fileName));
  const getChecksumValue = (row, label) => {
    const entry = Array.from(row?.querySelectorAll("dl.ck") || []).find(
      (checksum) => checksum.querySelector("dt")?.textContent?.trim().toLowerCase() === label.toLowerCase(),
    );
    return entry?.querySelector("dd")?.textContent?.trim() || "";
  };
  const getChecksums = (row) => ({
    crc32: getChecksumValue(row, "CRC32"),
    md5: getChecksumValue(row, "MD5"),
    sha1: getChecksumValue(row, "SHA-1"),
  });

  await expect
    .poll(() => getRows().filter((row) => row.textContent?.includes("direct-disc.")).length, {
      timeout: 30000,
    })
    .toBe(2);
  await expect.poll(() => getChecksums(getRow("direct-disc.bin")).crc32, { timeout: 30000 }).toMatch(/^[0-9a-f]{8}$/i);

  expect(getChecksums(getRow("direct-disc.cue"))).toEqual({ crc32: "", md5: "", sha1: "" });
  expect(getRow("direct-disc.cue")?.textContent || "").not.toContain("Fixes");
  expect(getChecksums(getRow("direct-disc.bin")).md5).toMatch(/^[0-9a-f]{32}$/i);
  expect(getChecksums(getRow("direct-disc.bin")).sha1).toMatch(/^[0-9a-f]{40}$/i);
});

test("direct CUE plus BIN upload can output CHD from the CUE source", async () => {
  const downloadNames = [];
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    downloadNames.push(this.download || "");
    return originalAnchorClick.apply(this, args);
  };
  try {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: {
          output: {
            compression: "chd",
          },
          workers: {
            threads: 2,
          },
        },
      }),
    );

    await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

    const sectorBytes = 2352;
    const sectorCount = 32;
    const binBytes = new Uint8Array(sectorBytes * sectorCount);
    for (let index = 0; index < binBytes.length; index += 1) {
      binBytes[index] = (index * 17) & 0xff;
    }
    const binFile = new File([binBytes], "direct-disc.bin", { type: "application/octet-stream" });
    const cueFile = new File(
      ['FILE "direct-disc.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n'],
      "direct-disc.cue",
      { type: "application/x-cue" },
    );

    selectFileInputs(document.getElementById("rom-weaver-input-file-rom"), [cueFile, binFile]);

    await expect
      .poll(() => getInputStackRows().filter((row) => row.textContent?.includes("direct-disc.")).length, {
        timeout: 30000,
      })
      .toBe(2);
    await waitForApplyButtonEnabled();
    await clickApplyButton();

    const applyState = await waitForApplyOutcome();
    expect(applyState).not.toBeNull();
    expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
    expect(downloadNames.at(-1)).toBe("direct-disc.chd");
  } finally {
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
});

test("split-bin checkbox is not rendered", async () => {
  const hiddenState = createEmptyPatcherUiState();
  mount(
    createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        output: inertOutputController,
        patchStack: inertStackController,
        ui: createStaticController(hiddenState),
      },
    }),
  );
  expect(document.getElementById("rom-weaver-checkbox-chd-split-bin")).toBeNull();

  const visibleState = createEmptyPatcherUiState();
  visibleState.chdSplitBin = {
    checked: true,
    disabled: false,
    label: "Split BIN tracks",
    visible: true,
  };
  mount(
    createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        output: inertOutputController,
        patchStack: inertStackController,
        ui: createStaticController(visibleState),
      },
    }),
  );

  expect(document.getElementById("rom-weaver-checkbox-chd-split-bin")).toBeNull();
});

test("ROM part dropzone hides after a non-disc ROM", async () => {
  const state = createEmptyPatcherUiState();
  state.romInputs = [createRomInputRowState({ info: { fileName: "game.nds" } })];
  mount(
    createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        output: inertOutputController,
        patchStack: inertStackController,
        ui: createStaticController(state),
      },
    }),
  );

  await expect
    .poll(() => document.getElementById("rom-weaver-list-input-stack")?.textContent || "")
    .toContain("game.nds");
  expect(document.getElementById("rom-weaver-input-file-rom")).toBeNull();
});

test("ROM part dropzone stays available for disc-style inputs", async () => {
  const state = createEmptyPatcherUiState();
  state.romInputs = [
    createRomInputRowState({
      info: { fileName: "direct-disc.bin" },
    }),
  ];
  mount(
    createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        output: inertOutputController,
        patchStack: inertStackController,
        ui: createStaticController(state),
      },
    }),
  );

  await expect
    .poll(() => document.getElementById("rom-weaver-input-file-rom")?.getAttribute("aria-label") || "")
    .toBe("Add another part for this ROM");

  const chdState = createEmptyPatcherUiState();
  chdState.romInputs = [
    createRomInputRowState({
      info: { fileName: "game.iso" },
      splitBinAvailable: true,
    }),
  ];
  mount(
    createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        output: inertOutputController,
        patchStack: inertStackController,
        ui: createStaticController(chdState),
      },
    }),
  );

  await expect
    .poll(() => document.getElementById("rom-weaver-input-file-rom")?.getAttribute("aria-label") || "")
    .toBe("Add another part for this ROM");
});

test("queued staging rows show waiting progress", async () => {
  const inputFiles = [
    new File([new Uint8Array([0, 1, 2, 3])], "first.nds", { type: "application/octet-stream" }),
    new File([new Uint8Array([4, 5, 6, 7])], "second.nds", { type: "application/octet-stream" }),
  ];
  const patchFiles = [
    new File([new Uint8Array([0x42, 0x50, 0x53, 0x31])], "first.bps", { type: "application/octet-stream" }),
    new File([new Uint8Array([0x42, 0x50, 0x53, 0x31])], "second.bps", { type: "application/octet-stream" }),
  ];
  let resolveInputStaging = () => undefined;
  let resolvePatchStaging = () => undefined;
  const inputStaging = new Promise((resolve) => {
    resolveInputStaging = () => resolve([]);
  });
  const patchStaging = new Promise((resolve) => {
    resolvePatchStaging = () => resolve([]);
  });
  const applyPatches = vi.fn(async () => createMockApplyResult());
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches,
        applyReady: true,
        defaultSettings: {
          defaultCompression: "auto",
        },
        downloadOutput: () => undefined,
        inputs: inputFiles,
        patches: patchFiles,
        stageInput: async () => inputStaging,
        stagePatches: async () => patchStaging,
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await expect
      .poll(() => Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .fileprog")).length)
      .toBe(2);
    await expect
      .poll(() => Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .fileprog")).length)
      .toBe(2);

    const inputProgressRows = Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .fileprog")).map(
      (row) => row.textContent || "",
    );
    const patchProgressRows = Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .fileprog")).map(
      (row) => row.textContent || "",
    );
    expect(inputProgressRows[0]).toContain("Preparing input");
    expect(inputProgressRows[1]).toContain("Waiting for other actions");
    expect(patchProgressRows[0]).toContain("Preparing patch");
    expect(patchProgressRows[1]).toContain("Waiting for other actions");

    let applyButton = document.getElementById("rom-weaver-button-apply");
    expect(applyButton).toBeInstanceOf(HTMLButtonElement);
    expect(applyButton.disabled).toBe(false);
    applyButton.click();
    await expect
      .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
      .toContain("Waiting for other actions");
    expect(document.querySelector("#rom-weaver-progress-apply .track.indet")).toBeTruthy();
    const outputName = document.getElementById("rom-weaver-input-output-file-name");
    const outputFormat = document.getElementById("rom-weaver-select-output-format");
    expect(outputName).toBeInstanceOf(HTMLTextAreaElement);
    expect(outputFormat).toBeInstanceOf(HTMLSelectElement);
    expect(outputName.disabled).toBe(false);
    expect(outputFormat.disabled).toBe(false);
    setFormControlValue(outputName, "queued-output");
    await expect.poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "").toBe("");
    expect(applyPatches).not.toHaveBeenCalled();

    applyButton = document.getElementById("rom-weaver-button-apply");
    expect(applyButton).toBeInstanceOf(HTMLButtonElement);
    applyButton.click();
    await expect
      .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
      .toContain("Waiting for other actions");
    resolveInputStaging();
    resolvePatchStaging();
    await expect.poll(() => applyPatches.mock.calls.length).toBe(1);
  } finally {
    resolveInputStaging();
    resolvePatchStaging();
  }
});

test("apply input staging errors render in the ROM section and can be dismissed", async () => {
  const inputFiles = [new File([new Uint8Array([0, 1, 2, 3])], "game.bin", { type: "application/octet-stream" })];
  const applyPatches = vi.fn(async () => createMockApplyResult());
  const stageInput = vi.fn(async () => {
    throw new Error("Input staging exploded");
  });
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches,
        applyReady: true,
        defaultSettings: {
          defaultCompression: "auto",
        },
        downloadOutput: () => undefined,
        inputs: inputFiles,
        patches: [],
        stageInput,
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  mount(createElement(Harness));

  await expect
    .poll(() => document.getElementById("rom-weaver-input-notice-message")?.textContent || "")
    .toContain("Input staging exploded");
  expect(document.getElementById("rom-weaver-output-notice-message")).toBeNull();

  const dismissButton = document.querySelector("#rom-weaver-input-notice-message .notice-x");
  expect(dismissButton).toBeInstanceOf(HTMLButtonElement);
  dismissButton.click();
  await expect.poll(() => document.getElementById("rom-weaver-input-notice-message")).toBeNull();
});

test("apply patch staging errors render in the patch section and can be dismissed", async () => {
  const inputFiles = [new File([new Uint8Array([0, 1, 2, 3])], "game.bin", { type: "application/octet-stream" })];
  const patchFiles = [
    new File([new Uint8Array([0x42, 0x50, 0x53, 0x31])], "change.bps", { type: "application/octet-stream" }),
  ];
  const applyPatches = vi.fn(async () => createMockApplyResult());
  const stageInput = vi.fn(async () => []);
  const stagePatches = vi.fn(async () => {
    throw new Error("Patch staging exploded");
  });
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches,
        applyReady: true,
        defaultSettings: {
          output: {
            compression: "zip",
          },
        },
        downloadOutput: () => undefined,
        inputs: inputFiles,
        patches: patchFiles,
        stageInput,
        stagePatches,
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  mount(createElement(Harness));

  await expect
    .poll(() => document.getElementById("rom-weaver-patch-notice-message")?.textContent || "")
    .toContain("Patch staging exploded");
  expect(document.getElementById("rom-weaver-output-notice-message")).toBeNull();

  const dismissButton = document.querySelector("#rom-weaver-patch-notice-message .notice-x");
  expect(dismissButton).toBeInstanceOf(HTMLButtonElement);
  dismissButton.click();
  await expect.poll(() => document.getElementById("rom-weaver-patch-notice-message")).toBeNull();
});

test("adding a ROM input preserves active input progress", async () => {
  const firstInput = new File([new Uint8Array([0, 1, 2, 3])], "first.nds", {
    type: "application/octet-stream",
  });
  const secondInput = new File([new Uint8Array([4, 5, 6, 7])], "second.nds", {
    type: "application/octet-stream",
  });
  let resolveInitialStaging = () => undefined;
  let resolveUpdatedStaging = () => undefined;
  const initialStaging = new Promise((resolve) => {
    resolveInitialStaging = () =>
      resolve([
        {
          fileName: "first.nds",
          id: "input-1",
          order: 0,
          size: firstInput.size,
          sourceSize: firstInput.size,
        },
      ]);
  });
  const updatedStaging = new Promise((resolve) => {
    resolveUpdatedStaging = () =>
      resolve([
        {
          fileName: "first.nds",
          id: "input-1",
          order: 0,
          size: firstInput.size,
          sourceSize: firstInput.size,
        },
        {
          fileName: "second.nds",
          id: "input-2",
          order: 1,
          size: secondInput.size,
          sourceSize: secondInput.size,
        },
      ]);
  });
  let latestUiController = null;
  const stageInput = vi.fn(async (snapshot) => (snapshot.inputs.length === 1 ? initialStaging : updatedStaging));
  const Harness = () => {
    const [inputs, setInputs] = useState([firstInput]);
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches: vi.fn(async () => createMockApplyResult()),
        applyReady: true,
        defaultSettings: {
          output: {
            compression: "zip",
          },
        },
        downloadOutput: () => undefined,
        inputs,
        onInputsChange: setInputs,
        patches: [],
        stageInput,
      });
    latestUiController = localUiController;
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await expect
      .poll(() =>
        Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .fileprog")).map(
          (row) => row.textContent || "",
        ),
      )
      .toEqual([expect.stringContaining("Preparing input")]);

    latestUiController.provideRomInputFiles([secondInput]);

    await expect
      .poll(() =>
        Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .fileprog")).map(
          (row) => row.textContent || "",
        ),
      )
      .toEqual([expect.stringContaining("Preparing input"), expect.stringContaining("Waiting for other actions")]);
    expect(stageInput.mock.calls.map((call) => call[0].inputs.length)).toEqual([1, 2]);
  } finally {
    resolveInitialStaging();
    resolveUpdatedStaging();
  }
});

test("apply can queue and start without a patch", async () => {
  const inputFiles = [new File([new Uint8Array([0, 1, 2, 3])], "game.bin", { type: "application/octet-stream" })];
  let resolveInputStaging = () => undefined;
  const inputStaging = new Promise((resolve) => {
    resolveInputStaging = () => resolve([]);
  });
  const applyPatches = vi.fn(async () => createMockApplyResult());
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches,
        applyReady: true,
        defaultSettings: {
          output: {
            compression: "zip",
          },
        },
        downloadOutput: () => undefined,
        inputs: inputFiles,
        patches: [],
        stageInput: async () => inputStaging,
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await expect
      .poll(() => {
        const applyButton = document.getElementById("rom-weaver-button-apply");
        return applyButton instanceof HTMLButtonElement && !applyButton.disabled;
      })
      .toBe(true);
    const applyButton = document.getElementById("rom-weaver-button-apply");
    expect(applyButton).toBeInstanceOf(HTMLButtonElement);
    applyButton.click();
    await expect
      .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
      .toContain("Waiting for other actions");
    expect(applyPatches).not.toHaveBeenCalled();

    resolveInputStaging();
    await expect.poll(() => applyPatches.mock.calls.length).toBe(1);
    expect(applyPatches.mock.calls[0][0].patches).toHaveLength(0);
  } finally {
    resolveInputStaging();
  }
});

test("apply queued default format follows unambiguous special compression input", async () => {
  const inputFiles = [new File([new Uint8Array([0, 1, 2, 3])], "game.gcm", { type: "application/octet-stream" })];
  let resolveInputStaging = () => undefined;
  const inputStaging = new Promise((resolve) => {
    resolveInputStaging = () => resolve([]);
  });
  const applyPatches = vi.fn(async () => createMockApplyResult());
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches,
        applyReady: true,
        defaultSettings: {
          defaultCompression: "auto",
        },
        downloadOutput: () => undefined,
        inputs: inputFiles,
        patches: [],
        stageInput: async () => inputStaging,
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await expect.poll(() => document.getElementById("rom-weaver-select-output-format")?.value || "").toBe("rvz");
    const applyButton = document.getElementById("rom-weaver-button-apply");
    expect(applyButton).toBeInstanceOf(HTMLButtonElement);
    applyButton.click();
    await expect
      .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
      .toContain("Waiting for other actions");
    expect(applyPatches).not.toHaveBeenCalled();

    resolveInputStaging();
    await expect.poll(() => applyPatches.mock.calls.length).toBe(1);
    expect(applyPatches.mock.calls[0][0].options.output.compression).toBe("rvz");
  } finally {
    resolveInputStaging();
  }
});

test("apply waits for a patch added before queued start", async () => {
  const inputFiles = [new File([new Uint8Array([0, 1, 2, 3])], "game.bin", { type: "application/octet-stream" })];
  const patchFiles = [
    new File([new Uint8Array([0x42, 0x50, 0x53, 0x31])], "change.bps", { type: "application/octet-stream" }),
  ];
  let resolveInputStaging = () => undefined;
  let resolvePatchStaging = () => undefined;
  const inputStaging = new Promise((resolve) => {
    resolveInputStaging = () => resolve([]);
  });
  const patchStaging = new Promise((resolve) => {
    resolvePatchStaging = () => resolve([]);
  });
  const applyPatches = vi.fn(async () => createMockApplyResult());
  const defaultSettings = {
    output: {
      compression: "zip",
    },
  };
  const downloadOutput = () => undefined;
  const stageInput = async () => inputStaging;
  const stagePatches = async () => patchStaging;
  let latestUiController = null;
  const Harness = () => {
    const [patches, setPatches] = useState([]);
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches,
        applyReady: true,
        defaultSettings,
        downloadOutput,
        inputs: inputFiles,
        onPatchesChange: setPatches,
        patches,
        stageInput,
        stagePatches,
      });
    latestUiController = localUiController;
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await expect
      .poll(() => {
        const applyButton = document.getElementById("rom-weaver-button-apply");
        return applyButton instanceof HTMLButtonElement && !applyButton.disabled;
      })
      .toBe(true);
    const applyButton = document.getElementById("rom-weaver-button-apply");
    expect(applyButton).toBeInstanceOf(HTMLButtonElement);
    applyButton.click();
    await expect
      .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
      .toContain("Waiting for other actions");
    expect(applyPatches).not.toHaveBeenCalled();

    latestUiController.providePatchInputFiles(patchFiles);
    await expect
      .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
      .toContain("Waiting for other actions");
    resolveInputStaging();
    resolvePatchStaging();
    await expect.poll(() => applyPatches.mock.calls.length).toBe(1);
    expect(applyPatches.mock.calls[0][0].patches).toHaveLength(1);
  } finally {
    resolveInputStaging();
    resolvePatchStaging();
  }
});

test("apply queued run cancels when staged patch validation fails", async () => {
  const inputFiles = [new File([new Uint8Array([0, 1, 2, 3])], "game.bin", { type: "application/octet-stream" })];
  const patchFiles = [
    new File([new Uint8Array([0x42, 0x50, 0x53, 0x31])], "change.bps", { type: "application/octet-stream" }),
  ];
  let resolveInputStaging = () => undefined;
  let resolvePatchStaging = () => undefined;
  const inputStaging = new Promise((resolve) => {
    resolveInputStaging = () => resolve([]);
  });
  const patchStaging = new Promise((resolve) => {
    resolvePatchStaging = () =>
      resolve([
        {
          fileName: "change.bps",
          validationMessage: "Patch validation failed",
          validationState: "invalid",
        },
      ]);
  });
  const applyPatches = vi.fn(async () => createMockApplyResult());
  const defaultSettings = {
    output: {
      compression: "zip",
    },
  };
  const downloadOutput = () => undefined;
  const stageInput = async () => inputStaging;
  const stagePatches = async () => patchStaging;
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches,
        applyReady: true,
        defaultSettings,
        downloadOutput,
        inputs: inputFiles,
        patches: patchFiles,
        stageInput,
        stagePatches,
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await expect
      .poll(() => {
        const applyButton = document.getElementById("rom-weaver-button-apply");
        return applyButton instanceof HTMLButtonElement && !applyButton.disabled;
      })
      .toBe(true);
    const applyButton = document.getElementById("rom-weaver-button-apply");
    expect(applyButton).toBeInstanceOf(HTMLButtonElement);
    applyButton.click();
    await expect
      .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
      .toContain("Waiting for other actions");

    resolvePatchStaging();
    await expect.poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "").toBe("");
    resolveInputStaging();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    expect(applyPatches).not.toHaveBeenCalled();
  } finally {
    resolveInputStaging();
    resolvePatchStaging();
  }
});

test("download-ready apply button does not duplicate ratio percent signs", async () => {
  const outputState = createEmptyPatcherOutputState();
  outputState.applyButton.disabled = false;
  outputState.disabled = false;
  outputState.compressionFormat = "zip";
  outputState.displayFileName = "game - change";
  outputState.options = [{ label: "ZIP", value: "zip" }];
  outputState.pendingDownloadFileName = "game - change.zip";
  outputState.downloadSummary = {
    format: "ZIP",
    ratio: "73.4%",
    size: "12.3 MB",
  };

  mount(
    createElement(PatcherPrimaryAction, {
      controller: createStaticController(outputState, {
        runPrimaryAction: () => undefined,
        setDisplayFileName: () => undefined,
        setOutputCompression: () => undefined,
        setOutputCompressOption: () => undefined,
      }),
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-button-apply")?.textContent || "").toContain("73.4%");
  expect(document.getElementById("rom-weaver-button-apply")?.textContent || "").not.toContain("%%");
});

test("apply output codec options refresh after per-job edits", async () => {
  const Harness = () => {
    const { localNoticeController, localOutputController, localStackController, localUiController } =
      useLocalApplyPatchFormSession({
        applyPatches: vi.fn(async () => createMockApplyResult()),
        applyReady: true,
        defaultSettings: {
          output: {
            compression: "zip",
          },
        },
        downloadOutput: () => undefined,
        inputs: [],
        patches: [],
        stageInput: async () => [],
        stagePatches: async () => [],
      });
    return createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  mount(createElement(Harness));

  await expect.poll(() => document.querySelector("details.outopts summary")?.textContent || "").toContain("deflate:9");
  document.querySelector("details.outopts summary")?.click();
  await expect.poll(() => document.querySelector('input[aria-label="ZIP codec"]')).not.toBeNull();
  setFormControlValue(document.querySelector('input[aria-label="ZIP codec"]'), "zstd");

  await expect.poll(() => document.querySelector('input[aria-label="ZIP codec"]')?.value || "").toBe("zstd");
  await expect.poll(() => document.querySelector("details.outopts summary")?.textContent || "").toContain("zstd:22");
});

test("clearing a selected archive input requires selection again when re-added", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  const archiveFile = await loadFixtureFile(MULTI_ROM_ZIP, "application/zip");
  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), archiveFile);
  await clickCandidateSelectionOption("game.bin");
  await waitForInputStackFileName();

  const clearButton = document.querySelector("button[title='Clear ROM input']");
  if (!(clearButton instanceof HTMLButtonElement)) throw new Error("Missing clear ROM input button");
  clearButton.click();

  await expect
    .poll(() => !document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file"), {
      timeout: 30000,
    })
    .toBe(true);

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), archiveFile);

  await expect.poll(() => !!getCandidateSelectionList(), { timeout: 30000 }).toBe(true);
});

test("cancelling input candidate selection removes the pending ROM input", async () => {
  await clearOpfsInputDirectory();
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-rom"),
    await loadFixtureFile(MULTI_ROM_ZIP, "application/zip"),
  );

  await expect.poll(() => getCandidateSelectionList()).not.toBeNull();

  const closeButton = getCandidateSelectionCloseButton();
  if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
  closeButton.click();

  await expect
    .poll(
      () =>
        !(
          getCandidateSelectionList() ||
          document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file")
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  await expect
    .poll(async () => (await listOpfsInputFilesMatching("multi-rom")).length, {
      interval: 50,
      timeout: 3000,
    })
    .toBe(0);
});

test("cancelling patch candidate selection removes the pending patch", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-patch")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-patch"),
    await loadFixtureFile(MULTI_PATCH_ZIP, "application/zip"),
  );

  await expect.poll(() => getCandidateSelectionList()).not.toBeNull();

  const closeButton = getCandidateSelectionCloseButton();
  if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
  closeButton.click();

  await expect
    .poll(
      () =>
        !(
          getCandidateSelectionList() ||
          document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file")
        ),
      { timeout: 30000 },
    )
    .toBe(true);
});

test("input stack shows resolved extracted disc filename after staging", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RVZ_INPUT));
  const rvzDisplayedName = await waitForInputStackFileName();
  expect(rvzDisplayedName).toContain("game.iso");

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(CHD_INPUT));
  const chdDisplayedName = await waitForInputStackFileName();
  expect(chdDisplayedName).not.toMatch(/\.chd$/i);
  expect(chdDisplayedName).toMatch(/\.(bin|iso)\b/i);
  expect(document.getElementById("rom-weaver-checkbox-chd-split-bin")).toBeNull();
});

test("patch row shows extraction progress and extracted patch naming", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-patch")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-patch"),
    await loadFixtureFile(ONE_PATCH_7Z, "application/x-7z-compressed"),
  );

  await clickPatchCandidateSelectionOption("change.ips");

  const patchState = await waitForState(() => {
    const patchFileName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file")?.textContent || "";
    const selectedPatchName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "";
    if (selectedPatchName.includes("change.ips") || patchFileName === "change.ips") return { kind: "ready" };
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(patchState).not.toBeNull();
  expect(patchState?.kind, patchState && "errorText" in patchState ? patchState.errorText : "").toBe("ready");

  await expect
    .poll(
      () =>
        document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "",
      { timeout: 30000 },
    )
    .toContain("change.ips");

  const archiveLabel =
    document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-archive")?.textContent || "";
  expect(archiveLabel).toContain("one-patch.7z");
  expect(archiveLabel).toContain("change.ips");
  expect(archiveLabel).toMatch(/\d+(?:\.\d)? (?:B|KB|MB|GB|TB)/);
  expect(
    document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-archive strong")?.textContent || "",
  ).toContain("change.ips");
});

test("deleting a selected patch archive requires selection again when re-added", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-patch")).not.toBeNull();

  const patchArchive = await loadFixtureFile(MULTI_PATCH_ZIP, "application/zip");
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), patchArchive);
  await clickPatchCandidateSelectionOption("change.ips");

  await expect
    .poll(
      () =>
        document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "",
      { timeout: 30000 },
    )
    .toContain("change.ips");

  const removeButton = document.querySelector("#rom-weaver-list-patch-stack button[aria-label='Remove patch']");
  if (!(removeButton instanceof HTMLButtonElement)) throw new Error("Missing remove patch button");
  removeButton.click();

  await expect
    .poll(() => !document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file"), {
      timeout: 30000,
    })
    .toBe(true);

  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), patchArchive);

  await expect.poll(() => !!getCandidateSelectionList(), { timeout: 30000 }).toBe(true);
});

test("adding an input after a staged patch does not reshow preparing patch progress", async () => {
  const progressEvents = [];
  mount(
    createElement(ApplyPatchForm, {
      onProgress: (event) => {
        progressEvents.push(event);
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();
  await expect.poll(() => document.getElementById("rom-weaver-input-file-patch")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-patch"),
    await loadFixtureFile(ONE_PATCH_7Z, "application/x-7z-compressed"),
  );
  await clickPatchCandidateSelectionOption("change.ips");

  await expect
    .poll(
      () =>
        document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "",
      { timeout: 30000 },
    )
    .toContain("change.ips");

  progressEvents.length = 0;

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
  await waitForApplyButtonEnabled();

  const patchPreparingEvents = progressEvents.filter((event) => {
    const role = String(event?.details?.role || "");
    const label = String(event?.label || "");
    return role === "patch" && /preparing patch/i.test(label);
  });
  expect(patchPreparingEvents).toHaveLength(0);

  const patchExtractEvents = progressEvents.filter((event) => {
    const details = event?.details || {};
    return String(details.role || "") === "patch" && String(details.stage || "") === "extract";
  });
  expect(patchExtractEvents).toHaveLength(0);
});

test("cancelling patch candidate selection does not trigger render-phase React warnings", async () => {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    mount(createElement(ApplyPatchForm));

    await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

    selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
    selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(MULTI_PATCH_ZIP));

    await expect.poll(() => getCandidateSelectionList()).not.toBeNull();

    const closeButton = getCandidateSelectionCloseButton();
    if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
    closeButton.click();

    await expect
      .poll(
        () =>
          !(
            getCandidateSelectionList() ||
            document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file")
          ),
        { timeout: 30000 },
      )
      .toBe(true);

    const warningCalls = consoleErrorSpy.mock.calls
      .map((args) => args.map((value) => String(value)).join(" "))
      .filter(
        (message) =>
          message.includes("triggering nested component updates from render") ||
          message.includes("flushSync was called from inside a lifecycle method"),
      );
    expect(warningCalls).toHaveLength(0);
  } finally {
    consoleErrorSpy.mockRestore();
  }
});

test("RVZ rom inputs auto-extract before apply", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RVZ_INPUT));

  await waitForInputStackFileName();
  await expect.poll(() => getInputStackFileName(), { timeout: 60000 }).toContain("game.iso");
});

test("CHD rom inputs auto-extract before apply", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(CHD_INPUT));

  await waitForInputStackFileName();
  await expect.poll(() => getInputStackFileName(), { timeout: 60000 }).not.toMatch(/\.chd$/i);
  await expect.poll(() => getInputStackFileName(), { timeout: 60000 }).toMatch(/game-cd\./i);
});

test("RVZ rom inputs can still run full apply workflow", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        output: {
          compression: "none",
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RVZ_INPUT));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
});

test("output compression selector keeps expected apply options", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-select-output-format")).not.toBeNull();

  const outputFormatSelect = document.getElementById("rom-weaver-select-output-format");
  const outputFormatValues = Array.from(outputFormatSelect.options || []).map((entry) => entry.value);

  expect(outputFormatValues).toContain("none");
  expect(outputFormatValues).toContain("zip");
  expect(outputFormatValues).toContain("7z");

  setFormControlValue(outputFormatSelect, "zip");
  expect(document.getElementById("rom-weaver-select-output-format")?.value).toBe("zip");
});

test("strict checksum mismatch blocks apply until override is checked", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        validation: {
          requireInputChecksumMatch: true,
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(WRONG_INPUT_BPS));

  const checksumOverrideCheckbox = await waitForState(() => {
    const checkbox = document.getElementById("rom-weaver-checkbox-checksum-override");
    return checkbox instanceof HTMLInputElement ? checkbox : null;
  }, 60000);
  expect(checksumOverrideCheckbox).toBeInstanceOf(HTMLInputElement);
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-patch-stack .file.bad .cks-match.bad"), {
      timeout: 60000,
    })
    .not.toBeNull();
  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply") instanceof HTMLButtonElement, {
      timeout: 30000,
    })
    .toBe(true);
  const applyButton = document.getElementById("rom-weaver-button-apply");
  expect(applyButton).toBeInstanceOf(HTMLButtonElement);
  expect(applyButton.disabled).toBe(false);

  checksumOverrideCheckbox.click();
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  await expect.poll(() => checksumOverrideCheckbox.checked, { timeout: 30000 }).toBe(false);

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind).toBe("download");
});

test("source-check patch formats report runtime patch validation success", async () => {
  for (const patchPath of [VALID_BPS, VALID_UPS]) {
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: {
          output: {
            compression: "none",
          },
        },
      }),
    );

    await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

    selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
    selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(patchPath));

    const validation = await waitForState(() => {
      const element = document.querySelector("#rom-weaver-list-patch-stack .file.ok");
      if (!(element instanceof HTMLElement)) return null;
      return /patch validation passed/i.test(element.textContent || "") ? element : null;
    }, 60000);
    expect(validation).toBeInstanceOf(HTMLElement);
    expect(validation.textContent).toMatch(/patch validation passed/i);
  }
});

test("checksum override dispatch uses one-shot validation relax", async () => {
  const applyPatchesSpy = vi.fn(async () => {
    throw new Error("forced apply failure");
  });
  mount(createChecksumOverrideHarnessElement(applyPatchesSpy));

  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply") instanceof HTMLButtonElement, { timeout: 30000 })
    .toBe(true);
  const applyButton = document.getElementById("rom-weaver-button-apply");
  expect(applyButton).toBeInstanceOf(HTMLButtonElement);
  expect(applyButton.disabled).toBe(false);

  const checksumOverrideCheckbox = await waitForState(() => {
    const checkbox = document.getElementById("rom-weaver-checkbox-checksum-override");
    return checkbox instanceof HTMLInputElement ? checkbox : null;
  }, 30000);
  expect(checksumOverrideCheckbox).toBeInstanceOf(HTMLInputElement);
  checksumOverrideCheckbox.click();

  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply") instanceof HTMLButtonElement, { timeout: 30000 })
    .toBe(true);
  await expect.poll(() => applyButton.disabled, { timeout: 30000 }).toBe(false);
  applyButton.click();

  await expect.poll(() => applyPatchesSpy.mock.calls.length, { timeout: 30000 }).toBe(1);
  await expect.poll(() => checksumOverrideCheckbox.checked, { timeout: 30000 }).toBe(false);
  const callInput = applyPatchesSpy.mock.calls[0]?.[0];
  expect(callInput?.options?.validation?.requireInputChecksumMatch).toBe(false);
});

test("expected validation sizes retain raw byte metadata and hide legacy actual input text", async () => {
  mount(createChecksumOverrideHarnessElement(vi.fn(async () => undefined)));

  const patchRow = await waitForState(() => {
    const row = getPatchStackRows()[0];
    if (!(row instanceof HTMLElement)) return null;
    return row.textContent?.includes("4.10 KB (4096 B)") ? row : null;
  }, 30000);
  expect(patchRow).toBeInstanceOf(HTMLElement);
  expect(patchRow?.textContent).toContain("1.02 KB (1024 B)");
  await expect
    .poll(
      () =>
        document.querySelector(
          "#rom-weaver-list-input-stack .rom-weaver-input-stack-file span[data-size-bytes='8192 B']",
        ),
      { timeout: 30000 },
    )
    .not.toBeNull();
  const inputTimingLabel = Array.from(
    document.querySelectorAll("#rom-weaver-list-input-stack .rom-weaver-input-stack-file span"),
  ).find((entry) => entry.textContent?.trim().startsWith("time:"));
  expect(inputTimingLabel?.getAttribute("data-size-bytes") || null).toBeNull();
  await expect
    .poll(
      () =>
        document.querySelector(
          "#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file span[data-size-bytes='16384 B']",
        ),
      { timeout: 30000 },
    )
    .not.toBeNull();

  const statusText = patchRow?.textContent || "";
  expect(statusText).not.toMatch(/size=4 B/i);
  expect(statusText).not.toMatch(/crc32=/i);
});

test("patch stack mentions when patch validation passed", async () => {
  mount(
    createChecksumOverrideHarnessElement(
      vi.fn(async () => undefined),
      {
        checksumPreflightMismatch: false,
        validationActualValue: "",
        validationLabel: "Validation",
        validationMessage: "Patch validation passed",
        validationState: "valid",
        validationValues: ["dry-run apply"],
      },
    ),
  );

  const validation = await waitForState(() => {
    const element = document.querySelector("#rom-weaver-list-patch-stack .file.ok");
    return element instanceof HTMLElement ? element : null;
  }, 30000);
  expect(validation.textContent).toMatch(/patch validation passed/i);
});
