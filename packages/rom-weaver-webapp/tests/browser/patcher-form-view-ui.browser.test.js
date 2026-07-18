import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { DiscTracksPanel } from "../../src/public/react/components/ds/source-info-list.tsx";
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

test("disc tracks use the Checks drawer's variant-group presentation", async () => {
  mount(
    createElement(DiscTracksPanel, {
      open: true,
      timing: "Checksum 204ms",
      tracks: [
        {
          bytes: 12_345,
          checksums: { crc32: "AAAA1111", md5: "a".repeat(32), sha1: "b".repeat(40) },
          id: "track-1",
          label: "Game (Track 1).bin",
        },
        {
          bytes: 67_890,
          checksums: { crc32: "BBBB2222", md5: "c".repeat(32), sha1: "d".repeat(40) },
          id: "track-2",
          label: "Game (Track 2).bin",
        },
      ],
    }),
  );

  await expect.poll(() => document.body.textContent || "").toContain("Checks");
  expect(document.body.textContent).not.toContain("Checks & Tracks");
  expect(document.querySelector(".cks-head .rb.time")?.textContent).toBe("Checksum 204ms");
  expect([...document.querySelectorAll(".ck-group-head")].map((head) => head.textContent?.trim())).toEqual([
    "Game (Track 1).bin",
    "Game (Track 2).bin",
  ]);
  expect(document.querySelectorAll(".cks .ck-group")).toHaveLength(2);
  expect(document.body.textContent).toContain("AAAA1111");
  expect(document.body.textContent).toContain("67890");
});
