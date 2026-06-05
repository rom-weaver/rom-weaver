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
    validationValues: ["size=4.00 KiB (4096 B)", "min_size=1.00 KiB (1024 B)", "crc32=deadbeef"],
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

const clickCandidateSelectionOption = async (label) => {
  const state = await waitForState(() => {
    const list = document.querySelector("#rom-weaver-candidate-selection-list");
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
  if (!document.querySelector("#rom-weaver-candidate-selection-list")) return;
  const button = Array.from(
    document.querySelectorAll(
      "#rom-weaver-candidate-selection-list button, #rom-weaver-candidate-selection-list [role='button']",
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
    const list = document.querySelector("#rom-weaver-candidate-selection-list");
    if (list) return { kind: "dialog" };
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(state).not.toBeNull();
  expect(state?.kind, state && "errorText" in state ? state.errorText : "").not.toBe("error");
  if (state?.kind === "selected") return;
  if (!document.querySelector("#rom-weaver-candidate-selection-list")) return;
  const button = Array.from(
    document.querySelectorAll(
      "#rom-weaver-candidate-selection-list button, #rom-weaver-candidate-selection-list [role='button']",
    ),
  ).find((entry) => entry.textContent?.includes(label));
  if (!button) throw new Error(`Missing patch candidate selection option: ${label}`);
  button.click();
};

const getInputStackFileName = () =>
  document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file strong")?.textContent?.trim() ||
  document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file")?.textContent?.trim() ||
  "";
const getInputStackFileNames = () =>
  Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .rom-weaver-input-stack-file strong"))
    .map((entry) => entry.textContent?.trim() || "")
    .filter(Boolean);
const getOutputFileNameValue = () => document.getElementById("rom-weaver-input-output-file-name")?.value || "";

const waitForInputStackFileName = async () => {
  const state = await waitForState(() => {
    if (hasStagingProgress()) return null;
    const fileName = getInputStackFileName();
    const trimmedName = fileName?.trim() || "";
    if (trimmedName && !/^\(\d+(?:\.\d+)?\s*(?:B|KiB|MiB|GiB)\)$/i.test(trimmedName)) {
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
  return files.filter((entry) => entry.path.includes(fragment));
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
    .poll(() => document.getElementById("rom-weaver-section-timing-output")?.textContent || "", { timeout: 30000 })
    .toMatch(/apply:/i);
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

  const removePatchButton = document.querySelector("button[title='Remove patch']");
  if (!(removePatchButton instanceof HTMLButtonElement)) throw new Error("Missing remove patch button");
  removePatchButton.click();

  await expect.poll(getOutputFileNameValue, { timeout: 30000 }).toBe("game.bin");
});

test("removing an input refreshes generated output name", async () => {
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

  const firstInput = await loadFixtureFile(RAW_ROM);
  const secondInput = new File([await firstInput.arrayBuffer()], "second.bin", { type: firstInput.type });
  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), firstInput);
  await waitForInputStackFileName();
  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), secondInput);

  await expect
    .poll(() => document.querySelectorAll("#rom-weaver-list-input-stack .rom-weaver-input-stack-file").length, {
      timeout: 30000,
    })
    .toBe(2);
  await expect.poll(getOutputFileNameValue, { timeout: 30000 }).toBe("game.bin");

  const removeInputButton = document.querySelector("button[title='Remove ROM input']");
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

  const getRows = () => Array.from(document.querySelectorAll("#rom-weaver-list-input-stack tr"));
  const getRow = (fileName) => getRows().find((row) => row.textContent?.includes(fileName));
  const getChecksums = (row) => ({
    crc32: row?.querySelector("[id^='rom-weaver-span-crc32']")?.textContent?.trim() || "",
    md5: row?.querySelector("[id^='rom-weaver-span-md5']")?.textContent?.trim() || "",
    sha1: row?.querySelector("[id^='rom-weaver-span-sha1']")?.textContent?.trim() || "",
  });

  await expect
    .poll(() => getRows().filter((row) => row.textContent?.includes("direct-disc.")).length, {
      timeout: 30000,
    })
    .toBe(2);
  await expect.poll(() => getChecksums(getRow("direct-disc.bin")).crc32, { timeout: 30000 }).toMatch(/^[0-9a-f]{8}$/i);

  expect(getRow("direct-disc.cue")?.querySelector(".rom-weaver-checksum-section")).toBeNull();
  expect(getChecksums(getRow("direct-disc.cue"))).toEqual({ crc32: "", md5: "", sha1: "" });
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
      .poll(
        () =>
          Array.from(document.querySelectorAll("#rom-weaver-list-input-stack tr")).filter((row) =>
            row.textContent?.includes("direct-disc."),
          ).length,
        { timeout: 30000 },
      )
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

test("split-bin checkbox renders only when CHD split-bin is available", async () => {
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
  const setChdSplitBin = vi.fn();
  mount(
    createElement(ApplyWorkflowFormView, {
      controllers: {
        dialog: inertDialogController,
        output: inertOutputController,
        patchStack: inertStackController,
        ui: createStaticController(visibleState, { setChdSplitBin }),
      },
    }),
  );

  await expect
    .poll(() => document.getElementById("rom-weaver-checkbox-chd-split-bin") instanceof HTMLInputElement)
    .toBe(true);
  const splitBinCheckbox = document.getElementById("rom-weaver-checkbox-chd-split-bin");
  expect(splitBinCheckbox).toBeInstanceOf(HTMLInputElement);
  expect(splitBinCheckbox.checked).toBe(true);
  splitBinCheckbox.click();
  expect(setChdSplitBin).toHaveBeenCalledWith(false);
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
          output: {
            compression: "zip",
          },
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
    size: "11.7 MiB",
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

  await expect
    .poll(() => !!document.querySelector("#rom-weaver-candidate-selection-list"), { timeout: 30000 })
    .toBe(true);
});

test("cancelling input candidate selection removes the pending ROM input", async () => {
  await clearOpfsInputDirectory();
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-rom"),
    await loadFixtureFile(MULTI_ROM_ZIP, "application/zip"),
  );

  await expect.poll(() => document.querySelector("#rom-weaver-candidate-selection-list")).not.toBeNull();

  const closeButton = document.querySelector(
    "#rom-weaver-candidate-selection-dialog button[aria-label='Close selection dialog']",
  );
  if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
  closeButton.click();

  await expect
    .poll(
      () =>
        !(
          document.querySelector("#rom-weaver-candidate-selection-list") ||
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

  await expect.poll(() => document.querySelector("#rom-weaver-candidate-selection-list")).not.toBeNull();

  const closeButton = document.querySelector(
    "#rom-weaver-candidate-selection-dialog button[aria-label='Close selection dialog']",
  );
  if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
  closeButton.click();

  await expect
    .poll(
      () =>
        !(
          document.querySelector("#rom-weaver-candidate-selection-list") ||
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
  expect(archiveLabel).toMatch(/\d+(?:\.\d)? (?:B|KiB|MiB|GiB)/);
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

  const removeButton = document.querySelector("#rom-weaver-list-patch-stack button[title='Remove patch']");
  if (!(removeButton instanceof HTMLButtonElement)) throw new Error("Missing remove patch button");
  removeButton.click();

  await expect
    .poll(() => !document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file"), {
      timeout: 30000,
    })
    .toBe(true);

  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), patchArchive);

  await expect
    .poll(() => !!document.querySelector("#rom-weaver-candidate-selection-list"), { timeout: 30000 })
    .toBe(true);
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
    const role = String((event?.details || {}).role || "");
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

    await expect.poll(() => document.querySelector("#rom-weaver-candidate-selection-list")).not.toBeNull();

    const closeButton = document.querySelector(
      "#rom-weaver-candidate-selection-dialog button[aria-label='Close selection dialog']",
    );
    if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
    closeButton.click();

    await expect
      .poll(
        () =>
          !(
            document.querySelector("#rom-weaver-candidate-selection-list") ||
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
    .poll(() => document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-validation.invalid"), {
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
  expect(applyButton.disabled).toBe(true);

  checksumOverrideCheckbox.click();
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  await expect.poll(() => checksumOverrideCheckbox.checked, { timeout: 30000 }).toBe(false);

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind).toBe("error");
  expect("errorText" in (applyState || {}) ? applyState.errorText : "").toMatch(/(checksum|mismatch|failed|invalid)/i);
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
      const element = document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-validation.valid");
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
  expect(applyButton.disabled).toBe(true);

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

test("expected validation sizes use byte tooltips and hide legacy actual input text", async () => {
  mount(createChecksumOverrideHarnessElement(vi.fn(async () => undefined)));

  const sizeValidationCode = await waitForState(() => {
    const code = document.querySelector(
      "#rom-weaver-list-patch-stack .rom-weaver-patch-stack-validation-required code",
    );
    return code instanceof HTMLElement ? code : null;
  }, 30000);
  expect(sizeValidationCode).toBeInstanceOf(HTMLElement);
  expect(sizeValidationCode?.textContent?.trim()).toBe("size=4.00 KiB");
  expect(sizeValidationCode?.getAttribute("data-size-bytes")).toBe("4096 B");
  expect(sizeValidationCode?.className).toMatch(/underline/);
  expect(sizeValidationCode?.getAttribute("aria-expanded")).toBe("false");
  sizeValidationCode?.click();
  await expect.poll(() => sizeValidationCode?.getAttribute("aria-expanded"), { timeout: 30000 }).toBe("true");
  await expect
    .poll(
      () => {
        const tooltip = sizeValidationCode?.parentElement?.querySelector("[role='tooltip']");
        return tooltip?.getAttribute("aria-hidden");
      },
      { timeout: 30000 },
    )
    .toBe("false");
  sizeValidationCode?.click();
  await expect.poll(() => sizeValidationCode?.getAttribute("aria-expanded"), { timeout: 30000 }).toBe("false");
  await expect
    .poll(
      () => {
        const tooltip = sizeValidationCode?.parentElement?.querySelector("[role='tooltip']");
        return tooltip?.getAttribute("aria-hidden");
      },
      { timeout: 30000 },
    )
    .toBe("true");
  const minSizeValidationCode = Array.from(
    document.querySelectorAll("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-validation-required code"),
  ).find((entry) => entry.textContent?.trim().startsWith("min_size="));
  expect(minSizeValidationCode).toBeInstanceOf(HTMLElement);
  expect(minSizeValidationCode?.className).not.toMatch(/underline/);
  expect(minSizeValidationCode?.getAttribute("data-size-bytes")).toBeNull();
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
  expect(inputTimingLabel).toBeInstanceOf(HTMLElement);
  expect(inputTimingLabel?.className).not.toMatch(/underline/);
  expect(inputTimingLabel?.getAttribute("data-size-bytes")).toBeNull();
  await expect
    .poll(
      () =>
        document.querySelector(
          "#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file span[data-size-bytes='16384 B']",
        ),
      { timeout: 30000 },
    )
    .not.toBeNull();
  const patchRowSize = document.querySelector(
    "#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file span[data-size-bytes='16384 B']",
  );
  expect(patchRowSize).toBeInstanceOf(HTMLElement);
  patchRowSize?.click();
  await expect.poll(() => patchRowSize?.getAttribute("aria-expanded"), { timeout: 30000 }).toBe("true");

  const statusText =
    document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-validation-status")?.textContent || "";
  expect(statusText).not.toMatch(/actual input/i);
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
    const element = document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-validation.valid");
    return element instanceof HTMLElement ? element : null;
  }, 30000);
  expect(validation.textContent).toMatch(/patch validation passed/i);
});
