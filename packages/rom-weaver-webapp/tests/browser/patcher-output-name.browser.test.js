import { createElement, useState } from "react";
import { expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { inertDialogController, useLocalApplyPatchFormSession } from "../../src/public/react/patcher-form-session.ts";
import {
  clickApplyButton,
  createMockApplyResult,
  getOutputFileNameValue,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  selectFileInput,
  setFormControlValue,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

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

    await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

    selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
    // The output section only renders once the workflow has an input; wait for the name field.
    await expect
      .poll(() => document.getElementById("rom-weaver-input-output-file-name"), { timeout: 30000 })
      .not.toBeNull();
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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_PATCH));

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

    await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

    selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
    selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_PATCH));

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
