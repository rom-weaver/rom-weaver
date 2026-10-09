import { resolveWeaveChecks } from "../../src/lib/weave/weave-targets.ts";
import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  installPatcherTestHooks,
  clickApplyButton,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  setFormControlValue,
  selectFileInput,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

// Pack files into a zip through the real compression runtime (what a patch
// distributor would publish).
const buildZip = async (entries, outputName) => {
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");
  const result = await create({
    entries,
    format: "zip",
    options: { outputName, threads: 1 },
  });
  const output = result?.output;
  if (!output) throw new Error("Zip compression did not return output");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], outputName, { type: "application/zip" });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

test("export weave weaves the session from main-page options with a checks-only rom entry", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  let exported = null;
  const saveAs = vi.spyOn(browserRuntime.publicOutput, "saveAs");
  mount(
    createElement(ApplyPatchForm, {
      onWeaveExportComplete: (result) => {
        exported = result;
      },
      pageDrop: { files: [romFile, patchFile], id: 1 },
    }),
  );
  await waitForApplyButtonEnabled();

  // Weave authoring is a separate secondary job below Apply.
  await waitForState(() => document.getElementById("rom-weaver-weave-job"));
  expect(document.querySelector(".outopts #rom-weaver-weave-export-format")).toBeNull();
  const weaveDrawer = document.querySelector("#rom-weaver-weave-job .cks-head");
  expect(weaveDrawer?.textContent).toContain("Share this patch recipe (for patch creators)");
  expect(weaveDrawer?.getAttribute("aria-expanded")).toBe("false");
  weaveDrawer?.click();
  await expect.poll(() => weaveDrawer?.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById("rom-weaver-weave-export-weave-rom")).toBeTruthy();
  expect(document.getElementById("rom-weaver-weave-export-weave-rom").checked).toBe(false);
  expect(document.querySelector("#rom-weaver-weave-job .notice")).toBeNull();
  expect(window.location.hash).toBe("");

  // Choosing a package also arms the export action.
  const exportButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-weave");
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  });
  expect(exportButton).not.toBeNull();
  const nameInput = document.getElementById("rom-weaver-input-output-file-name");
  expect(nameInput).not.toBeNull();
  setFormControlValue(nameInput, "Exported Hack");

  // The pencil on the patch card opens the inline name/description editors.
  document.getElementById("rom-weaver-patch-meta-edit-0")?.click();
  const patchNameInput = await waitForState(() => document.getElementById("rom-weaver-patch-name-0"));
  expect(patchNameInput).not.toBeNull();
  setFormControlValue(patchNameInput, "Core change");
  patchNameInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  const descriptionInput = document.getElementById("rom-weaver-patch-description-0");
  expect(descriptionInput).not.toBeNull();
  setFormControlValue(descriptionInput, "Adds the change");
  descriptionInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  // The committed description remounts the keyed inline field (the static card
  // line stays hidden while editing) - wait for that render before exporting.
  await expect.poll(() => document.getElementById("rom-weaver-patch-description-0") !== descriptionInput).toBe(true);
  // Version + author ride the same form and export with the entry.
  const versionInput = document.getElementById("rom-weaver-patch-version-0");
  expect(versionInput).not.toBeNull();
  setFormControlValue(versionInput, "1.4.0");
  versionInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  const authorInput = document.getElementById("rom-weaver-patch-author-0");
  expect(authorInput).not.toBeNull();
  setFormControlValue(authorInput, "Weaver");
  authorInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  // Committed values remount the keyed fields - wait for both renders so the
  // export click reads the updated metadata.
  await expect.poll(() => document.getElementById("rom-weaver-patch-version-0") !== versionInput).toBe(true);
  await expect.poll(() => document.getElementById("rom-weaver-patch-author-0") !== authorInput).toBe(true);

  // Close the editor first: the actions menu (and its replace input) takes the
  // done-check's slot back once editing ends.
  document.getElementById("rom-weaver-patch-meta-edit-0")?.click();
  await expect.poll(() => document.getElementById("rom-weaver-patch-replace-input-0")).not.toBeNull();

  // Replacing the source keeps this slot's inline metadata and version edits.
  const replacementFile = new File([await patchFile.arrayBuffer()], "replacement.ips", {
    type: "application/octet-stream",
  });
  document.getElementById("rom-weaver-patch-replace-0")?.click();
  selectFileInput(document.getElementById("rom-weaver-patch-replace-input-0"), replacementFile);
  await expect
    .poll(() =>
      document.querySelector("#rom-weaver-list-patch-stack .nmline[data-file-name]")?.getAttribute("data-file-name"),
    )
    .toBe("replacement.ips");
  await waitForApplyButtonEnabled();
  // Expected input checks live in the Checks drawer: open it and add a CRC32.
  document.querySelector("#rom-weaver-list-patch-stack .cks-head")?.click();
  const addCheck = await waitForState(() => document.getElementById("rom-weaver-patch-input-add-check-0"));
  addCheck.value = "crc32";
  addCheck.dispatchEvent(new Event("change", { bubbles: true }));
  const checksInput = await waitForState(() => document.getElementById("rom-weaver-patch-input-crc32-0"));
  expect(checksInput).not.toBeNull();
  setFormControlValue(checksInput, "deadbeef");
  checksInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  // Committing returns the row to text, so the value reads off the resting cell rather
  // than the field (EditableCheckRow keeps the field out of the way between edits).
  await expect.poll(() => document.getElementById("rom-weaver-patch-input-crc32-0-open")?.textContent).toBe("deadbeef");

  // The weave follows the Apply Compression type and leaves the ROM out.
  expect(document.getElementById("rom-weaver-weave-export-weave-rom").checked).toBe(false);

  // A patch switched off while authoring remains in the recipe as an optional
  // entry that starts off when another person opens the weave.
  const patchToggle = document.querySelector("#rom-weaver-list-patch-stack .patch-enable input");
  expect(patchToggle).toBeInstanceOf(HTMLInputElement);
  expect(patchToggle.checked).toBe(true);
  patchToggle.click();
  await expect.poll(() => patchToggle.checked).toBe(false);

  // The patch update runs chain validation before the export action is ready again.
  const readyExportButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-weave");
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  });
  readyExportButton.click();

  // The runtime create call resolves with the canonical weave - assert on it directly rather
  // than intercepting the browser download.
  const result = await waitForState(() => exported, 60000);
  expect(result).not.toBeNull();
  expect(result.weave.version).toBe(2);
  expect(result.weave.patchBasis).toBe("auto");
  // Weaves carry no display name; the export name feeds output naming only.
  expect(result.weave.name).toBeUndefined();
  expect(result.weave.output?.name).toBe("Exported Hack");
  expect(result.weavePath.endsWith("rom-weaver-weave.json")).toBe(true);
  // The weave download is named from the export name.
  expect(result.archivePath?.endsWith("Exported-Hack.zip")).toBe(true);
  // The ROM stays out of the weave: its entry carries checks but no source.
  expect(result.weave.rom?.path ?? null).toBeNull();
  expect(result.weave.rom?.url ?? null).toBeNull();
  expect(result.weave.rom?.name).toBe(RAW_ROM.split("/").pop());
  expect(
    Object.keys(
      resolveWeaveChecks(result.weave, result.weave.rom?.checks, result.weave.rom?.checksRef)?.checksums || {},
    ).length,
  ).toBeGreaterThan(0);
  expect(result.weave.patches).toHaveLength(1);
  const patchEntry = result.weave.patches[0];
  expect(patchEntry.id).toBeTruthy();
  expect(patchEntry.version).toBe("1.4.0");
  // The entry carries the replacement source, matching the file name the patch
  // row shows after the replace above.
  expect(patchEntry.path).toBe("replacement.ips");
  expect(patchEntry.optional).toBe(true);
  expect(patchEntry.name).toBe("Core change");
  expect(patchEntry.author).toBe("Weaver");
  expect(patchEntry.description).toBe("Adds the change");
  // The hand-typed crc32 differs from the rom checks, so the entry keeps its
  // own check-state reference instead of relying on the ROM state.
  expect(resolveWeaveChecks(result.weave, patchEntry.inputChecks, patchEntry.inputChecksRef)?.checksums?.crc32).toBe(
    "deadbeef",
  );
  expect(patchEntry.inputChecksRef).toBeDefined();
  expect(patchEntry.inputChecks).toBeUndefined();
  // Export does not invent a final output check; only explicit/user-entered
  // checks are retained.
  expect(patchEntry.outputChecks).toBeUndefined();
  expect(result.weave.output?.checks).toBeUndefined();
  // Patch entries carry no file hashes - the format has no integrity field.
  expect(patchEntry.integrity).toBeUndefined();

  // Wait for the completed export to restore the Download action after its progress state.
  const downloadButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-weave");
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  }, 30000);
  expect(downloadButton.textContent).toContain("Download");
  const firstResult = exported;
  setFormControlValue(await waitForState(() => document.getElementById("rom-weaver-select-patch-target-0")), "rom");
  const shareButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-weave");
    return button instanceof HTMLButtonElement && !button.disabled && button.textContent?.includes("Share")
      ? button
      : null;
  });
  shareButton.click();
  const updatedResult = await waitForState(() => (exported === firstResult ? null : exported), 60000);
  expect(updatedResult.weave.patches[0]?.basis).toBe("base");

  const updatedDownloadButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-weave");
    return button instanceof HTMLButtonElement && !button.disabled && button.textContent?.includes("Download")
      ? button
      : null;
  });
  updatedDownloadButton.click();
  await expect.poll(() => saveAs.mock.calls.length).toBe(3);
  await expect.poll(() => updatedDownloadButton.disabled).toBe(false);
  saveAs.mockRestore();
});

// The screenshot capture opens this drawer with a strict locator, so the selector MUST identify exactly one head.
test("the weave drawer is addressable by a single selector inside the output row", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [romFile, patchFile], id: 1 } }));
  await waitForApplyButtonEnabled();
  await waitForState(() => document.getElementById("rom-weaver-weave-job"));

  const outputRow = document.getElementById("rom-weaver-row-output-file-name");
  expect(outputRow).not.toBeNull();

  // The selector the capture actually uses MUST resolve to exactly one head.
  const anchored = outputRow.querySelectorAll("#rom-weaver-weave-job > .cks > .cks-head");
  expect(anchored.length).toBe(1);
  expect(anchored[0].textContent).toContain("Share this patch recipe (for patch creators)");

  // It stays correct only because it is anchored: the row carries more than one
  // drawer, so the unanchored selector this replaced is ambiguous by design.
  const unanchored = outputRow.querySelectorAll(".cks > .cks-head");
  expect(unanchored.length).toBeGreaterThan(1);

  // The field the capture waits for lives behind this drawer, so it must start
  // closed or the capture would screenshot the wrong state.
  expect(anchored[0].getAttribute("aria-expanded")).toBe("false");
});

test("keeps the sharing job after an ordinary Apply completes", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [romFile, patchFile], id: 1 } }));
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });

  const applyButton = document.getElementById("rom-weaver-button-apply");
  const job = document.getElementById("rom-weaver-weave-job");
  expect(job?.textContent).toContain("Share this patch recipe (for patch creators)");
  expect(applyButton?.compareDocumentPosition(job || document.body)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(document.querySelector(".outopts #rom-weaver-weave-export-format")).toBeNull();
  expect(document.getElementById("rom-weaver-weave-export-format")).toBeNull();
  expect(document.getElementById("rom-weaver-button-export-weave")).not.toBeNull();
});

test("export weaves the extracted patch leaf, not the archive it arrived in", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const patchZip = await buildZip([{ file: patchFile, fileName: "change.ips" }], "patch-pack.zip");
  let exported = null;
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: { weavePackage: "rom" },
      onWeaveExportComplete: (result) => {
        exported = result;
      },
      pageDrop: { files: [romFile, patchZip], id: 1 },
    }),
  );
  await waitForApplyButtonEnabled();

  // The persisted weavePackage setting preselects the ROM choice.
  await waitForState(() => document.getElementById("rom-weaver-weave-export-weave-rom"));
  expect(document.getElementById("rom-weaver-weave-rom-name")).toBeNull();
  const exportButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-weave");
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  });
  await expect
    .poll(() =>
      document.querySelector("#rom-weaver-list-patch-stack .nmline[data-file-name]")?.getAttribute("data-file-name"),
    )
    .toBe("change.ips");
  exportButton.click();
  const result = await waitForState(() => exported, 60000);
  expect(result).not.toBeNull();
  // The weave references (and the weave carries) the .ips leaf.
  expect(result.weave.patches).toHaveLength(1);
  expect(result.weave.patches[0].path).toBe("change.ips");
  expect(result.weave.rom?.path).toBe(RAW_ROM.split("/").pop());
  await expect.poll(() => exportButton.disabled).toBe(false);
});
