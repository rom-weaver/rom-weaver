import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
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
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

// crc32 of tests/fixtures/archive_sources/game.bin ("ORIGINAL-ROM\n").
const RAW_ROM_CRC32 = "c6fb1252";
const strict = { defaultSettings: { validation: { requireInputChecksumMatch: true } } };

const renamed = async (fileName) => {
  const patch = await loadFixtureFile(RAW_PATCH);
  return new File([await patch.arrayBuffer()], fileName, { type: patch.type });
};

const stage = async (patchName) => {
  mount(createElement(ApplyPatchForm, strict));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  const input = document.getElementById("rom-weaver-input-file-unified");
  selectFileInput(input, await loadFixtureFile(RAW_ROM));
  selectFileInput(input, await renamed(patchName));
};

test("a patch whose filename crc32 token mismatches the ROM is blocked until Apply anyway", async () => {
  await stage("hack [crc32:4af1a4bb].ips");
  const checkbox = await waitForState(() => {
    const element = document.getElementById("rom-weaver-checkbox-checksum-override");
    return element instanceof HTMLInputElement ? element : null;
  }, 60000);
  expect(checkbox).toBeInstanceOf(HTMLInputElement);
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-patch-stack .file.bad .cks-match.bad"), { timeout: 60000 })
    .not.toBeNull();
  // The engine's dry run lands after the cheap preflight and knows nothing of the file-name token;
  // the mismatch must survive it instead of flipping the card to Verified.
  await expect
    .poll(() => document.getElementById("rom-weaver-list-patch-stack")?.textContent ?? "", { timeout: 60000 })
    .not.toContain("Checking patch against the ROM");
  expect(document.querySelector("#rom-weaver-list-patch-stack .file.bad .cks-match.bad")).not.toBeNull();
  expect(document.getElementById("rom-weaver-list-patch-stack")?.textContent).not.toContain("Verified");

  checkbox.click();
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome?.kind).toBe("download");
});

test("a patch whose filename crc32 token matches the ROM shows as verified", async () => {
  await stage(`hack [crc32:${RAW_ROM_CRC32}].ips`);
  await expect
    .poll(() => document.getElementById("rom-weaver-list-patch-stack")?.textContent ?? "", { timeout: 45000 })
    .toContain("Verified");
  await waitForApplyButtonEnabled();
  expect(document.querySelector("#rom-weaver-list-patch-stack .file.bad")).toBeNull();
  expect(document.getElementById("rom-weaver-checkbox-checksum-override")).toBeNull();
});

const crc32Hex = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
};

// A minimal iNES ROM (16-byte header + 2x16K PRG + 8K CHR) so the header option is offered.
const buildInesBytes = () => {
  const bytes = new Uint8Array(16 + 2 * 16384 + 8192).fill(0x11);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 0x02, 0x01, 0x01, 0x00]);
  bytes.fill(0, 8, 16);
  return bytes;
};

const stageInes = async (declaredCrc32) => {
  mount(createElement(ApplyPatchForm, strict));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  const input = document.getElementById("rom-weaver-input-file-unified");
  selectFileInput(input, new File([buildInesBytes()], "game.nes", { type: "application/octet-stream" }));
  selectFileInput(input, await renamed(`hack [crc32:${declaredCrc32}].ips`));
  const headerSelect = await waitForState(() => document.getElementById("rom-weaver-patch-header-mode-0"), 60000);
  expect(headerSelect).not.toBeNull();
  return headerSelect;
};

test("auto header strips when the filename crc32 names the headerless bytes", async () => {
  const headerSelect = await stageInes(crc32Hex(buildInesBytes().subarray(16)));
  await expect.poll(() => headerSelect.options[0].textContent, { timeout: 60000 }).toBe("header auto (strip)");
});

test("auto header keeps the header when the filename crc32 names the headered bytes", async () => {
  const headerSelect = await stageInes(crc32Hex(buildInesBytes()));
  await expect.poll(() => headerSelect.options[0].textContent, { timeout: 60000 }).toBe("header auto (keep)");
});

// tests/fixtures/archive_sources/multi-patch: change.ips turns game.bin into crc32 2cccfa33, which
// alternate.ips (the second patch) then reads.
const CHAIN_PATCH_A = "tests/fixtures/archive_sources/multi-patch/change.ips";
const CHAIN_PATCH_B = "tests/fixtures/archive_sources/multi-patch/alternate.ips";
const CHAIN_A_OUTPUT_CRC32 = "2cccfa33";

test("a later patch whose filename crc32 token names the previous patch's output is not flagged", async () => {
  mount(createElement(ApplyPatchForm, strict));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  const input = () => document.getElementById("rom-weaver-input-file-unified");
  selectFileInput(input(), await loadFixtureFile(RAW_ROM));
  selectFileInput(input(), await loadFixtureFile(CHAIN_PATCH_A));
  const second = await loadFixtureFile(CHAIN_PATCH_B);
  selectFileInput(
    input(),
    new File([await second.arrayBuffer()], `b [crc32:${CHAIN_A_OUTPUT_CRC32}].ips`, { type: second.type }),
  );
  await expect
    .poll(() => document.querySelectorAll("#rom-weaver-list-patch-stack .file").length, { timeout: 60000 })
    .toBe(2);
  await expect
    .poll(() => document.getElementById("rom-weaver-list-patch-stack")?.textContent ?? "", { timeout: 60000 })
    .not.toContain("Checking patch against the ROM");
  // Let the engine's dry run land; the file-name token must not turn it into a mismatch.
  await expect
    .poll(() => document.getElementById("rom-weaver-patch-chain-chip-1")?.textContent?.trim() ?? "", { timeout: 60000 })
    .not.toBe("");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 3000));
  expect(document.querySelector("#rom-weaver-list-patch-stack .file.bad")).toBeNull();
  expect(document.getElementById("rom-weaver-checkbox-checksum-override")).toBeNull();
  await waitForApplyButtonEnabled();
});

test("turning off the first patch makes the next patch's filename crc32 token apply to the ROM", async () => {
  mount(createElement(ApplyPatchForm, strict));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  const input = () => document.getElementById("rom-weaver-input-file-unified");
  selectFileInput(input(), await loadFixtureFile(RAW_ROM));
  selectFileInput(input(), await loadFixtureFile(CHAIN_PATCH_A));
  const second = await loadFixtureFile(CHAIN_PATCH_B);
  selectFileInput(
    input(),
    new File([await second.arrayBuffer()], `b [crc32:${CHAIN_A_OUTPUT_CRC32}].ips`, { type: second.type }),
  );
  const toggles = () => Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .patch-enable input"));
  await expect.poll(() => toggles().length, { timeout: 60000 }).toBe(2);
  await expect
    .poll(() => document.getElementById("rom-weaver-list-patch-stack")?.textContent ?? "", { timeout: 60000 })
    .not.toContain("Checking patch against the ROM");
  expect(document.querySelector("#rom-weaver-list-patch-stack .file.bad")).toBeNull();
  // Now b runs first, on the original ROM, which its token does not name.
  toggles()[0].click();
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-patch-stack .file.bad .cks-match.bad"), { timeout: 60000 })
    .not.toBeNull();
  expect(document.getElementById("rom-weaver-checkbox-checksum-override")).not.toBeNull();
  // Turning it back on restores the chain, where the token names change.ips's output.
  toggles()[0].click();
  await expect
    .poll(() => document.querySelector("#rom-weaver-list-patch-stack .file.bad"), { timeout: 60000 })
    .toBeNull();
  await waitForApplyButtonEnabled();
});
