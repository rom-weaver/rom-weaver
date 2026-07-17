import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { PatcherPrimaryAction } from "../../src/public/react/components/patcher-output-controls.tsx";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { inertDialogController, useLocalApplyPatchFormSession } from "../../src/public/react/patcher-form-session.ts";
import {
  clickApplyButton,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  selectFileInput,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

test("apply progress cancel button invokes primary cancel without visible cancel text", async () => {
  const cancelPrimaryAction = vi.fn();
  const runPrimaryAction = vi.fn();
  const state = {
    applyButton: {
      disabled: false,
      label: "Weave patch",
      loading: true,
      progress: {
        message: "Weaving patch...",
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
    .poll(() => document.querySelector("button[aria-label='Cancel weaving']") instanceof HTMLButtonElement)
    .toBe(true);
  const cancelButton = document.querySelector("button[aria-label='Cancel weaving']");
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
  // Apply-time input processing surfaces a live staging status on the input row.
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-input-stack .stage-status")?.textContent || "")
    .toContain("Checksumming");
  expect(document.querySelector("#rom-weaver-list-input-stack")?.textContent || "").toContain("game.bin");

  const cancelButton = document.querySelector("button[aria-label='Cancel weaving']");
  expect(cancelButton).toBeInstanceOf(HTMLButtonElement);
  cancelButton.click();

  await expect.poll(() => document.querySelector("#rom-weaver-list-input-stack .stage-status")).toBeNull();
  await expect
    .poll(() => {
      const applyButton = document.getElementById("rom-weaver-button-apply");
      return (
        applyButton instanceof HTMLButtonElement &&
        !applyButton.disabled &&
        /weave/i.test(applyButton.textContent || "")
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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_PATCH));

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
