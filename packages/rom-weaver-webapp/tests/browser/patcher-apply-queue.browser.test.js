import { createElement, useState } from "react";
import { expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { inertDialogController, useLocalApplyPatchFormSession } from "../../src/public/react/patcher-form-session.ts";
import { createMockApplyResult, installPatcherTestHooks, mount } from "./patcher-test-shared.js";

installPatcherTestHooks();

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
