import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { PatcherPrimaryAction } from "../../src/public/react/components/patcher-output-controls.tsx";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { inertDialogController, useLocalApplyPatchFormSession } from "../../src/public/react/patcher-form-session.ts";
import { createEmptyPatcherOutputState } from "../../src/public/react/patcher-presentation.ts";
import {
  clearOpfsOutputDirectory,
  clickApplyButton,
  createMockApplyResult,
  createStaticController,
  installPatcherTestHooks,
  listOpfsOutputFiles,
  loadFixtureFile,
  mount,
  ONE_ROM_ZIP,
  RAW_PATCH,
  RAW_ROM,
  selectFileInput,
  setFormControlValue,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
  await expect.poll(async () => (await listOpfsOutputFiles()).length, { timeout: 30000 }).toBeGreaterThan(0);

  setFormControlValue(document.getElementById("rom-weaver-select-output-format"), "zip");

  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply")?.textContent || "", { timeout: 30000 })
    .toContain("Weave");
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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(ONE_ROM_ZIP));
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_PATCH));

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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(ONE_ROM_ZIP));
  const initialPatch = await loadFixtureFile(RAW_PATCH);
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), initialPatch);

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
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), replacementPatch);
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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");

  const outputFiles = await listOpfsOutputFiles();
  expect(outputFiles.some((entry) => /\.zip$/i.test(entry.name))).toBe(true);
  expect(outputFiles.some((entry) => entry.name === "game - change")).toBe(false);
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
  // The output section (and its codec options) only renders once the workflow has an input.
  const inputFile = new File([new Uint8Array([0, 1, 2, 3])], "game.bin", { type: "application/octet-stream" });
  const stagedInputInfo = {
    fileName: "game.bin",
    id: "input-1",
    order: 0,
    size: 4,
    sourceSize: 4,
  };
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
        inputs: [inputFile],
        patches: [],
        stageInput: async (_snapshot, handlers) => {
          handlers.onState(stagedInputInfo);
          return [stagedInputInfo];
        },
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

  await expect.poll(() => document.querySelector(".outopts .cks-head")?.textContent || "").toContain("deflate:9");
  document.querySelector(".outopts .cks-head")?.click();
  await expect.poll(() => document.querySelector('input[aria-label="ZIP codec"]')).not.toBeNull();
  setFormControlValue(document.querySelector('input[aria-label="ZIP codec"]'), "zstd");

  await expect.poll(() => document.querySelector('input[aria-label="ZIP codec"]')?.value || "").toBe("zstd");
  await expect.poll(() => document.querySelector(".outopts .cks-head")?.textContent || "").toContain("zstd:22");
});

test("output compression selector keeps expected apply options", async () => {
  mount(createElement(ApplyPatchForm));

  // The output section only renders once the workflow has an input.
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));

  await expect
    .poll(() => document.getElementById("rom-weaver-select-output-format"), { timeout: 30000 })
    .not.toBeNull();

  const outputFormatSelect = document.getElementById("rom-weaver-select-output-format");
  const outputFormatValues = Array.from(outputFormatSelect.options || []).map((entry) => entry.value);

  expect(outputFormatValues).toContain("none");
  expect(outputFormatValues).toContain("zip");
  expect(outputFormatValues).toContain("7z");

  setFormControlValue(outputFormatSelect, "zip");
  expect(document.getElementById("rom-weaver-select-output-format")?.value).toBe("zip");
});
