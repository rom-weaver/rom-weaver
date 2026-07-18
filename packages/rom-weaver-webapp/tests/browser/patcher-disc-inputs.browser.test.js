import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  CHD_INPUT,
  clickApplyButton,
  getInputStackFileName,
  getInputStackRows,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  RVZ_INPUT,
  selectFileInput,
  selectFileInputs,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForInputStackFileName,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

test("direct CUE plus BIN upload shows the cue sheet on the bin row", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  expect(document.getElementById("rom-weaver-input-file-unified")?.multiple).toBe(true);

  const rawInput = await loadFixtureFile(RAW_ROM);
  const binFile = new File([await rawInput.arrayBuffer()], "direct-disc.bin", { type: "application/octet-stream" });
  const cueText = 'FILE "direct-disc.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n';
  const cueFile = new File([cueText], "direct-disc.cue", { type: "application/x-cue" });

  selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [cueFile, binFile]);

  const getRows = () => getInputStackRows();
  const getRow = (fileName) => getRows().find((row) => row.textContent?.includes(fileName));
  const getChecksumValue = (row, label) => {
    const entry = Array.from(row?.querySelectorAll(".ck") || []).find(
      (checksum) => checksum.querySelector(".ck-k")?.textContent?.trim().toLowerCase() === label.toLowerCase(),
    );
    return entry?.querySelector(".ck-v")?.textContent?.trim() || "";
  };
  const getChecksums = (row) => ({
    crc32: getChecksumValue(row, "CRC32"),
    md5: getChecksumValue(row, "MD5"),
    sha1: getChecksumValue(row, "SHA-1"),
  });

  // The cue is not its own row anymore: only the bin row is shown.
  await expect
    .poll(() => getRows().filter((row) => row.textContent?.includes("direct-disc.bin")).length, {
      timeout: 30000,
    })
    .toBe(1);
  await expect
    .poll(() => getChecksums(getRow("direct-disc.bin")).crc32, { timeout: 30000 })
    .toMatch(/^(?!0{8}$)[0-9a-f]{8}$/i);

  const binRow = getRow("direct-disc.bin");
  // The bin keeps its checksums; the cue rides alongside as a read-only section.
  expect(getChecksums(binRow).md5).toMatch(/^[0-9a-f]{32}$/i);
  expect(getChecksums(binRow).sha1).toMatch(/^[0-9a-f]{40}$/i);
  const cueSection = binRow?.querySelector(".rw-cue-section");
  expect(cueSection).not.toBeNull();
  expect(cueSection?.textContent || "").toContain('FILE "direct-disc.bin" BINARY');
  expect(cueSection?.querySelector(".cue-sub-head")).toBeNull();
  expect(binRow?.querySelector(".rw-cue-copy")).not.toBeNull();

  const filesDrawer = binRow?.querySelector(".extract-d");
  expect(filesDrawer?.querySelector(".lab")?.textContent).toBe("Files");
  expect(filesDrawer?.querySelector(".rb:not(.time)")?.textContent || "").toContain("B");
  filesDrawer?.querySelector(".cks-head")?.click();
  await expect
    .poll(() => Array.from(filesDrawer?.querySelectorAll(".tree-name") || []).map((entry) => entry.textContent?.trim()))
    .toEqual(["direct-disc.cue", "direct-disc.bin"]);
});

test("direct CUE plus BIN upload can output CHD from the CUE source", async () => {
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
            compression: "chd",
          },
          workers: {
            threads: 2,
          },
        },
      }),
    );

    await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

    const sectorBytes = 2352;
    const sectorCount = 32;
    const binBytes = new Uint8Array(sectorBytes * sectorCount);
    for (let index = 0; index < binBytes.length; index += 1) {
      binBytes[index] = (index * 17) & 0xff;
    }
    const binFile = new File([binBytes], "direct-disc.bin", { type: "application/octet-stream" });
    const cueFile = new File(
      ['FILE "direct-disc.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n'],
      "direct-disc.cue",
      { type: "application/x-cue" },
    );

    selectFileInputs(document.getElementById("rom-weaver-input-file-unified"), [cueFile, binFile]);

    await expect
      .poll(() => getInputStackRows().filter((row) => row.textContent?.includes("direct-disc.bin")).length, {
        timeout: 30000,
      })
      .toBe(1);
    await waitForApplyButtonEnabled();
    await clickApplyButton();

    const applyState = await waitForApplyOutcome();
    expect(applyState).not.toBeNull();
    expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
    expect(downloadNames.at(-1)).toBe("direct-disc.chd");
  } finally {
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
});

test("input stack shows resolved extracted disc filename after staging", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RVZ_INPUT));
  const rvzDisplayedName = await waitForInputStackFileName();
  expect(rvzDisplayedName).toContain("game.iso");

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(CHD_INPUT));
  const chdDisplayedName = await waitForInputStackFileName();
  expect(chdDisplayedName).not.toMatch(/\.chd$/i);
  expect(chdDisplayedName).toMatch(/\.(bin|iso)\b/i);
  expect(document.getElementById("rom-weaver-checkbox-chd-split-bin")).toBeNull();
});

test("RVZ rom inputs auto-extract before apply", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RVZ_INPUT));

  await waitForInputStackFileName();
  await expect.poll(() => getInputStackFileName(), { timeout: 60000 }).toContain("game.iso");
});

test("CHD rom inputs auto-extract before apply", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(CHD_INPUT));
  await waitForInputStackFileName();
  await expect.poll(() => getInputStackFileName(), { timeout: 60000 }).not.toMatch(/\.chd$/i);
  await expect.poll(() => getInputStackFileName(), { timeout: 60000 }).toMatch(/game-cd\./i);
});

test("RVZ rom inputs can still run full apply workflow", async () => {
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

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RVZ_INPUT));
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
});
