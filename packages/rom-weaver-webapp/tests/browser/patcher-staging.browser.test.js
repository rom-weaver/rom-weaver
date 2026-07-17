import { createElement, useState } from "react";
import { expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { inertDialogController, useLocalApplyPatchFormSession } from "../../src/public/react/patcher-form-session.ts";
import { createMockApplyResult, installPatcherTestHooks, mount, setFormControlValue } from "./patcher-test-shared.js";

installPatcherTestHooks();

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
      .poll(() => Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .stage-status")).length)
      .toBe(2);
    await expect
      .poll(() => Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .stage-status")).length)
      .toBe(2);

    const inputProgressRows = Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .stage-status")).map(
      (row) => row.textContent || "",
    );
    const patchProgressRows = Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .stage-status")).map(
      (row) => row.textContent || "",
    );
    // Every staging row (the active one and the queued one) carries an
    // observable staging status: inputs read "Checksumming…", patches "Reading…".
    // The queued-vs-active distinction now surfaces on the apply run action
    // (#rom-weaver-progress-apply, asserted below), not per row.
    expect(inputProgressRows[0]).toContain("Checksumming");
    expect(inputProgressRows[1]).toContain("Checksumming");
    expect(patchProgressRows[0]).toContain("Reading");
    expect(patchProgressRows[1]).toContain("Reading");

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
        Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .stage-status")).map(
          (row) => row.textContent || "",
        ),
      )
      .toEqual([expect.stringContaining("Checksumming")]);

    latestUiController.provideRomInputFiles([secondInput]);

    // Adding a second input must not wipe the first row's in-flight staging
    // status: the first row still shows its "Checksumming…" progress and the new
    // (queued) row joins with its own staging status.
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll("#rom-weaver-list-input-stack .stage-status")).map(
          (row) => row.textContent || "",
        ),
      )
      .toEqual([expect.stringContaining("Checksumming"), expect.stringContaining("Checksumming")]);
    expect(stageInput.mock.calls.map((call) => call[0].inputs.length)).toEqual([1, 2]);
  } finally {
    resolveInitialStaging();
    resolveUpdatedStaging();
  }
});
