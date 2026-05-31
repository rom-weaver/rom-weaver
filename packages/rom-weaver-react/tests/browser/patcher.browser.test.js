import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  inertDialogController,
  inertOutputController,
  inertStackController,
} from "../../src/public/react/patcher-form-session.ts";
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

test("runtime failures surface actionable error messaging", async () => {
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

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind).toBe("error");
  expect("errorText" in (applyState || {}) ? applyState.errorText : "").toMatch(/(checksum|mismatch|failed|invalid)/i);
});
