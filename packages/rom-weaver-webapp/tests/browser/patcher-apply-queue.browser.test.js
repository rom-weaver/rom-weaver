import { createElement, useState } from "react";
import { expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { useLocalApplyPatchFormSession } from "../../src/public/react/patcher-form-session.ts";
import { createMockApplyResult, installPatcherTestHooks, mount } from "./patcher-test-shared.js";

installPatcherTestHooks();

const waitForStagingProgress = async (role) => {
  await expect.poll(() => document.querySelector(`[id^="rom-weaver-progress-${role}"]`)).not.toBeNull();
};

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
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await waitForStagingProgress("rom");
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
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await waitForStagingProgress("rom");
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
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await waitForStagingProgress("rom");
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
        notice: localNoticeController,
        output: localOutputController,
        patchStack: localStackController,
        ui: localUiController,
      },
    });
  };

  try {
    mount(createElement(Harness));

    await waitForStagingProgress("patch");
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

for (const clickTiming of ["before mismatch", "during mismatch"]) {
  for (const finalMismatch of [false, true]) {
    test(`queued Apply ${clickTiming} waits for checksum validation (final mismatch: ${finalMismatch})`, async () => {
      const inputs = [new File([new Uint8Array([0, 1, 2, 3])], "game.bin")];
      const patches = [new File(["BPS1"], "chain-step-a.bps"), new File(["BPS1"], "chain-step-b.bps")];
      let finishInput;
      let finishPatches;
      let finishValidation;
      const inputStaging = new Promise((resolve) => {
        finishInput = () => resolve([]);
      });
      const patchStaging = new Promise((resolve) => {
        finishPatches = resolve;
      });
      const validation = new Promise((resolve) => {
        finishValidation = resolve;
      });
      const mismatchInfos = patches.map((patch) => ({
        fileName: patch.name,
        checksumPreflightMismatch: true,
        validationState: "invalid",
        validationMessage: "Source requirements mismatch",
      }));
      const applyPatches = vi.fn(async () => createMockApplyResult());
      const validatePatches = vi.fn(async () => validation);
      const Harness = () => {
        const { localNoticeController, localOutputController, localStackController, localUiController } =
          useLocalApplyPatchFormSession({
            applyPatches,
            applyReady: true,
            defaultSettings: { validation: { requireInputChecksumMatch: true } },
            downloadOutput: () => undefined,
            inputs,
            patches,
            stageInput: async () => inputStaging,
            stagePatches: async () => patchStaging,
            validatePatches,
          });
        return createElement(ApplyWorkflowFormView, {
          controllers: {
            notice: localNoticeController,
            output: localOutputController,
            patchStack: localStackController,
            ui: localUiController,
          },
        });
      };
      const clickApply = () => {
        const button = document.getElementById("rom-weaver-button-apply");
        expect(button).toBeInstanceOf(HTMLButtonElement);
        expect(button.disabled).toBe(false);
        button.click();
      };
      try {
        mount(createElement(Harness));
        await waitForStagingProgress("rom");
        if (clickTiming === "before mismatch") clickApply();
        finishPatches(mismatchInfos);
        await expect.poll(() => document.getElementById("rom-weaver-checkbox-checksum-override")).not.toBeNull();
        if (clickTiming === "during mismatch") clickApply();
        await expect
          .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
          .toContain("Waiting for other actions");
        expect(applyPatches).not.toHaveBeenCalled();
        finishInput();
        await expect.poll(() => document.querySelector(`[id^="rom-weaver-progress-rom"]`)).toBeNull();
        expect(validatePatches).toHaveBeenCalled();
        expect(applyPatches).not.toHaveBeenCalled();
        finishValidation(
          finalMismatch
            ? mismatchInfos
            : patches.map((patch) => ({
                fileName: patch.name,
                checksumPreflightMismatch: false,
                validationState: "valid",
              })),
        );
        if (finalMismatch) {
          await expect.poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "").toBe("");
          expect(applyPatches).not.toHaveBeenCalled();
          expect(document.getElementById("rom-weaver-checkbox-checksum-override")?.checked).toBe(false);
        } else {
          await expect.poll(() => applyPatches.mock.calls.length).toBe(1);
          expect(applyPatches.mock.calls[0][0].patches).toEqual(patches);
          expect(applyPatches.mock.calls[0][0].options.validation.requireInputChecksumMatch).toBe(true);
        }
      } finally {
        finishInput();
        finishPatches([]);
        finishValidation([]);
      }
    });
  }
}

for (const queueBeforeFailure of [true, false]) {
  test(`input staging rejection clears Apply queue (${queueBeforeFailure ? "queued" : "clicked after failure"})`, async () => {
    const input = new File([new Uint8Array([0, 1, 2, 3])], "broken.bin");
    const replacement = new File([new Uint8Array([4, 5, 6, 7])], "replacement.bin");
    let rejectStaging;
    const staging = new Promise((_resolve, reject) => {
      rejectStaging = reject;
    });
    const applyPatches = vi.fn(async () => createMockApplyResult());
    const stageInput = vi.fn(async (snapshot) => {
      if (snapshot.inputs[0] === input) return staging;
      return [{ fileName: replacement.name, size: replacement.size }];
    });
    let latestUiController;
    let makeReady;
    const Harness = () => {
      const [ready, setReady] = useState(false);
      makeReady = () => setReady(true);
      const { localNoticeController, localOutputController, localStackController, localUiController } =
        useLocalApplyPatchFormSession({
          applyPatches,
          applyReady: ready,
          defaultInputs: [input],
          downloadOutput: () => undefined,
          stageInput,
        });
      latestUiController = localUiController;
      return createElement(ApplyWorkflowFormView, {
        controllers: {
          notice: localNoticeController,
          output: localOutputController,
          patchStack: localStackController,
          ui: localUiController,
        },
      });
    };
    const clickApply = () => {
      const button = document.getElementById("rom-weaver-button-apply");
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(button.disabled).toBe(false);
      button.click();
    };
    mount(createElement(Harness));
    await waitForStagingProgress("rom");
    if (queueBeforeFailure) {
      clickApply();
      await expect
        .poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "")
        .toContain("Waiting for other actions");
    }
    rejectStaging(new Error("Cannot prepare broken.bin. Replace the input and try again."));
    await expect.poll(() => document.body.textContent).toContain("Cannot prepare broken.bin");
    await expect.poll(() => document.getElementById("rom-weaver-progress-apply")?.textContent || "").toBe("");
    await expect.poll(() => document.querySelector('[id^="rom-weaver-progress-rom"]')).toBeNull();
    clickApply();
    await expect.poll(() => document.body.textContent).toContain("Cannot prepare broken.bin");
    expect(document.getElementById("rom-weaver-progress-apply")).toBeNull();
    expect(applyPatches).not.toHaveBeenCalled();
    latestUiController.clearRomInput();
    await expect.poll(() => document.body.textContent || "").not.toContain("Cannot prepare broken.bin");
    latestUiController.provideRomInputFile(replacement);
    await expect.poll(() => stageInput.mock.calls.length).toBe(2);
    await expect.poll(() => document.querySelector('[id^="rom-weaver-progress-rom"]')).toBeNull();
    makeReady();
    await expect.poll(() => document.getElementById("rom-weaver-button-apply")?.disabled).toBe(false);
    expect(applyPatches).not.toHaveBeenCalled();
    clickApply();
    await expect.poll(() => applyPatches.mock.calls.length).toBe(1);
    expect(applyPatches.mock.calls[0][0].inputs).toEqual([replacement]);
  });
}
