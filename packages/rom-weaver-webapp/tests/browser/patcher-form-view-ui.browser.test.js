import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import {
  inertDialogController,
  inertOutputController,
  inertStackController,
} from "../../src/public/react/patcher-form-session.ts";
import { createEmptyPatcherUiState } from "../../src/public/react/patcher-ui-state.ts";
import { createStaticController, installPatcherTestHooks, mount } from "./patcher-test-shared.js";

installPatcherTestHooks();

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

test("unified drop stays available after a non-disc ROM", async () => {
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
  const unifiedInput = document.getElementById("rom-weaver-input-file-unified");
  expect(unifiedInput).not.toBeNull();
  expect(unifiedInput?.multiple).toBe(true);
});

test("unified drop accepts additional parts for disc-style inputs", async () => {
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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  expect(document.getElementById("rom-weaver-input-file-unified")?.multiple).toBe(true);

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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  expect(document.getElementById("rom-weaver-input-file-unified")?.multiple).toBe(true);
});
