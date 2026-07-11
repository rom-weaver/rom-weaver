import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  CHD_INPUT,
  clearOpfsInputDirectory,
  clickApplyButton,
  clickCandidateSelectionOption,
  getCandidateSelectionCloseButton,
  getCandidateSelectionList,
  getInputStackRows,
  installPatcherTestHooks,
  listOpfsInputFilesMatching,
  listOpfsStagedInputSourceFiles,
  loadFixtureFile,
  MULTI_PATCH_ZIP,
  MULTI_ROM_ZIP,
  mount,
  RAW_PATCH,
  RAW_ROM,
  selectFileInput,
  selectFileInputs,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForInputStackFileName,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const makeNamedRom = async (fileName, fill) => {
  const raw = await loadFixtureFile(RAW_ROM);
  const bytes = new Uint8Array(await raw.arrayBuffer());
  if (typeof fill === "number") bytes.fill(fill);
  return new File([bytes], fileName, { type: "application/octet-stream" });
};

test("uploading multiple separate ROMs prompts which one and keeps only the chosen input", async () => {
  await clearOpfsInputDirectory();
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [
    await makeNamedRom("alpha.bin", 0x11),
    await makeNamedRom("beta.bin", 0x22),
  ]);

  // Multiple distinct ROMs => a single-select "which one?" prompt (no multi-select checklist).
  await expect.poll(() => !!getCandidateSelectionList(), { timeout: 30000 }).toBe(true);

  await clickCandidateSelectionOption("alpha.bin");
  const stagedName = await waitForInputStackFileName();
  expect(stagedName).toContain("alpha.bin");

  // The unchosen ROM is dropped: exactly one input row remains, and the dialog is closed.
  expect(getInputStackRows()).toHaveLength(1);
  expect(getCandidateSelectionList()).toBeNull();
  expect(
    getInputStackRows().some((row) => (row.textContent || "").includes("beta.bin")),
    "beta.bin should have been discarded after picking alpha.bin",
  ).toBe(false);
});

test("the chosen ROM from a multi-ROM prompt runs the full apply workflow", async () => {
  await clearOpfsInputDirectory();
  mount(createElement(ApplyPatchForm, { defaultSettings: { output: { compression: "none" } } }));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  // alpha.bin keeps the original ROM bytes the patch targets; beta.bin is unrelated filler.
  selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [
    await makeNamedRom("alpha.bin"),
    await makeNamedRom("beta.bin", 0x22),
  ]);

  await expect.poll(() => !!getCandidateSelectionList(), { timeout: 30000 }).toBe(true);
  await clickCandidateSelectionOption("alpha.bin");
  await waitForInputStackFileName();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
});

test("cancelling the multi-ROM prompt clears the pending ROM input", async () => {
  await clearOpfsInputDirectory();
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [
    await makeNamedRom("alpha.bin", 0x11),
    await makeNamedRom("beta.bin", 0x22),
  ]);

  await expect.poll(() => !!getCandidateSelectionList(), { timeout: 30000 }).toBe(true);
  const closeButton = getCandidateSelectionCloseButton();
  if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
  closeButton.click();

  await expect.poll(() => !(getCandidateSelectionList() || getInputStackRows().length), { timeout: 30000 }).toBe(true);
});

test("candidate selection resolves multi-entry archive inputs", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(CHD_INPUT));
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

test("clearing a selected archive input requires selection again when re-added", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  const archiveFile = await loadFixtureFile(MULTI_ROM_ZIP, "application/zip");
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), archiveFile);
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

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), archiveFile);

  await expect.poll(() => !!getCandidateSelectionList(), { timeout: 30000 }).toBe(true);
  const closeButton = document.querySelector(".rw-modal.select-modal .modal-head button[aria-label='Close']");
  if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
  closeButton.click();
});

test("cancelling input candidate selection removes the pending ROM input", async () => {
  await clearOpfsInputDirectory();
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
    await loadFixtureFile(MULTI_ROM_ZIP, "application/zip"),
  );

  await expect.poll(() => getCandidateSelectionList()).not.toBeNull();

  const closeButton = getCandidateSelectionCloseButton();
  if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
  closeButton.click();

  await expect
    .poll(
      () =>
        !(
          getCandidateSelectionList() ||
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

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
    await loadFixtureFile(MULTI_PATCH_ZIP, "application/zip"),
  );

  await expect.poll(() => getCandidateSelectionList()).not.toBeNull();

  const closeButton = getCandidateSelectionCloseButton();
  if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
  closeButton.click();

  await expect
    .poll(
      () =>
        !(
          getCandidateSelectionList() ||
          document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file")
        ),
      { timeout: 30000 },
    )
    .toBe(true);
});

test("cancelling patch candidate selection does not trigger render-phase React warnings", async () => {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    mount(createElement(ApplyPatchForm));

    await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

    selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
    selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(MULTI_PATCH_ZIP));

    await expect.poll(() => getCandidateSelectionList()).not.toBeNull();

    const closeButton = getCandidateSelectionCloseButton();
    if (!(closeButton instanceof HTMLButtonElement)) throw new Error("Missing candidate selection close button");
    closeButton.click();

    await expect
      .poll(
        () =>
          !(
            getCandidateSelectionList() ||
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
