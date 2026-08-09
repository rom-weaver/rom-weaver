import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyWorkflowFormView } from "../../src/public/react/apply-workflow-form-view.tsx";
import { DiscTracksPanel, SourceInfoList } from "../../src/public/react/components/ds/source-info-list.tsx";
import { inertOutputController, inertStackController } from "../../src/public/react/patcher-form-session.ts";
import { createEmptyPatcherUiState } from "../../src/public/react/patcher-ui-state.ts";
import { createStaticController, installPatcherTestHooks, mount } from "./patcher-test-shared.js";

installPatcherTestHooks();

const createRomInputRowState = (overrides = {}) => {
  const { info: infoOverrides = {}, ...rowOverrides } = overrides;
  return {
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
    progress: null,
    ...rowOverrides,
  };
};

test("unified drop stays available after a non-disc ROM", async () => {
  const state = createEmptyPatcherUiState();
  state.romInputs = [createRomInputRowState({ info: { fileName: "game.nds" } })];
  mount(
    createElement(ApplyWorkflowFormView, {
      controllers: {
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
        output: inertOutputController,
        patchStack: inertStackController,
        ui: createStaticController(state),
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

test("successful ROM checks stay compact but expose a matching summary", async () => {
  mount(
    createElement(SourceInfoList, {
      bytes: 4,
      checksums: { crc32: "c6fb1252" },
      expected: { checksums: { crc32: "c6fb1252" } },
      fileName: "game.bin",
      verificationSummary: "matches your ROM",
    }),
  );

  await expect.poll(() => document.querySelector(".cks-head")).not.toBeNull();
  const head = document.querySelector(".cks-head");
  expect(head).toBeInstanceOf(HTMLButtonElement);
  expect(head.getAttribute("aria-expanded")).toBe("false");
  expect(head.textContent).toContain("matches your ROM");

  head.click();
  await expect.poll(() => document.querySelector(".ck-v")?.textContent || "").toContain("c6fb1252");
});

test("mismatched ROM checks open their recovery details", async () => {
  mount(
    createElement(SourceInfoList, {
      bytes: 4,
      checksums: { crc32: "c6fb1252" },
      expected: { checksums: { crc32: "deadbeef" } },
      fileName: "game.bin",
      verificationMismatchSummary: "does not match the expected ROM",
    }),
  );

  await expect.poll(() => document.querySelector(".cks-head")).not.toBeNull();
  const head = document.querySelector(".cks-head");
  expect(head).toBeInstanceOf(HTMLButtonElement);
  expect(head.getAttribute("aria-expanded")).toBe("true");
  expect(document.body.textContent).toContain("does not match the expected ROM");
  expect(document.body.textContent).toContain("deadbeef");
});
