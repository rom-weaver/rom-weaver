import { createElement } from "react";
import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  selectFileInput,
  waitForApplyButtonEnabled,
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

// game.bin's raw crc32 (see patcher-checksum-validation's typed-checksum test).
const ROM_CRC32 = "c6fb1252";

const buildZip = async (entries, outputName) => {
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");
  const result = await create({
    entries,
    format: "zip",
    options: { outputName, workerThreads: 1 },
  });
  const output = result?.output;
  if (!output) throw new Error("Zip compression did not return output");
  try {
    // Materialize the bytes before dispose() deletes the backing OPFS file - a
    // File built straight from the blob references that file lazily, and reads
    // during the later drop intermittently fail once it is gone.
    const blob = await browserRuntime.publicOutput.getBlob(output);
    const bytes = await blob.arrayBuffer();
    return new File([bytes], outputName, { type: "application/zip" });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

/** Each built zip gets a unique name - back-to-back tests staging identically
 * named archives race the previous test's OPFS cleanup. */
let bundleZipSeq = 0;

/** A checks-only (without-ROM) bundle zip: index + core patch + optional patch. */
const buildWithoutRomBundle = async ({ romCrc32, outputCrc32 }) => {
  const patchFile = await loadFixtureFile(RAW_PATCH);
  const alternateFile = new File([await patchFile.arrayBuffer()], "alternate.ips", {
    type: "application/octet-stream",
  });
  const bundleJson = {
    output: {
      ...(outputCrc32 ? { checks: { checksums: { crc32: outputCrc32 } } } : {}),
      name: "bundled-output",
    },
    patches: [
      { name: "Core", path: "change.ips" },
      { name: "Alternate", optional: true, path: "alternate.ips" },
    ],
    rom: { checks: { checksums: { crc32: romCrc32 } }, name: "game.bin" },
    version: 1,
  };
  const bundleFile = new File([JSON.stringify(bundleJson)], "rom-weaver-bundle.json", { type: "application/json" });
  return buildZip(
    [
      { file: bundleFile, fileName: "rom-weaver-bundle.json" },
      { file: patchFile, fileName: "change.ips" },
      { file: alternateFile, fileName: "alternate.ips" },
    ],
    `without-rom-${++bundleZipSeq}.zip`,
  );
};

const getPatchToggles = () => Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .patch-enable input"));

test("authoring fields stay hidden until bundle-edit mode; enter/exit round-trips the hash", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [romFile, patchFile], id: 1 } }));
  await waitForApplyButtonEnabled();

  // Default apply view: no authoring fields, no export controls; the mode's
  // persistent switch sits at the top of the form, off.
  expect(document.getElementById("rom-weaver-patch-name-0")).toBeNull();
  expect(document.getElementById("rom-weaver-patch-input-crc32-0")).toBeNull();
  expect(document.getElementById("rom-weaver-rom-bundle-crc32")).toBeNull();
  const modeToggle = document.getElementById("rom-weaver-toggle-bundle-edit");
  expect(modeToggle).not.toBeNull();
  expect(modeToggle.checked).toBe(false);
  expect(document.getElementById("rom-weaver-bundle-edit-bar")?.classList.contains("is-active")).toBe(false);
  expect(document.getElementById("rom-weaver-bundle-export-format")).toBeNull();

  // The output card's "Create bundle…" action enters the editor.
  document.getElementById("rom-weaver-button-bundle-edit")?.click();
  await expect.poll(() => window.location.hash).toBe("#bundle-edit");
  const editBar = await waitForState(() => document.getElementById("rom-weaver-bundle-edit-bar"));
  expect(editBar.classList.contains("is-active")).toBe(true);
  expect(document.getElementById("rom-weaver-toggle-bundle-edit")?.checked).toBe(true);
  await expect.poll(() => document.getElementById("rom-weaver-patch-name-0")).not.toBeNull();
  expect(document.getElementById("rom-weaver-patch-input-crc32-0")).not.toBeNull();
  // The ROM card gains the bundle-checks editor, prefilled with computed hashes.
  await waitForState(() => document.getElementById("rom-weaver-rom-bundle-crc32"));
  await expect
    .poll(() => document.getElementById("rom-weaver-rom-bundle-crc32")?.placeholder, { timeout: 30000 })
    .toBe(ROM_CRC32);
  expect(document.getElementById("rom-weaver-bundle-export-format")).not.toBeNull();
  expect(document.getElementById("rom-weaver-button-export-bundle")).not.toBeNull();

  // Switching the mode off leaves the editor and clears the deep link; the
  // switch itself stays put.
  document.getElementById("rom-weaver-toggle-bundle-edit")?.click();
  await expect.poll(() => document.getElementById("rom-weaver-patch-name-0")).toBeNull();
  expect(window.location.hash).toBe("");
  expect(document.getElementById("rom-weaver-toggle-bundle-edit")?.checked).toBe(false);
  expect(document.getElementById("rom-weaver-bundle-edit-bar")?.classList.contains("is-active")).toBe(false);
});

test("#bundle-edit hash deep-links straight into the editor", async () => {
  window.location.hash = "bundle-edit";
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [romFile, patchFile], id: 1 } }));
  await waitForApplyButtonEnabled();

  const editBar = await waitForState(() => document.getElementById("rom-weaver-bundle-edit-bar"));
  expect(editBar.classList.contains("is-active")).toBe(true);
  await expect.poll(() => document.getElementById("rom-weaver-patch-name-0")).not.toBeNull();
});

test("bundle-expected ROM checks fold into the staged ROM card with match marks", async () => {
  const [romFile, bundleArchive] = await Promise.all([
    loadFixtureFile(RAW_ROM),
    buildWithoutRomBundle({ romCrc32: ROM_CRC32 }),
  ]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive, romFile], id: 1 } }));

  // The expected group unmounts while the ROM stages (its computed values are
  // pending), so settle the bench first, then re-query the live DOM per poll.
  await waitForApplyButtonEnabled();
  const expectedGroup = () => document.getElementById("rom-weaver-rom-expected-checks");
  await waitForState(expectedGroup, 30000);
  expect(expectedGroup().textContent).toContain("Expected");
  expect(expectedGroup().textContent).toContain(ROM_CRC32);
  // The matching ROM earns the per-row verified mark once its hash lands.
  await expect.poll(() => !!expectedGroup()?.querySelector(".ck-mark.ok"), { timeout: 30000 }).toBe(true);
  expect(expectedGroup().querySelector(".ck-mark.bad")).toBeNull();
});

test("a mismatching ROM flags the expected rows", async () => {
  const [romFile, bundleArchive] = await Promise.all([
    loadFixtureFile(RAW_ROM),
    buildWithoutRomBundle({ romCrc32: "deadbeef" }),
  ]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive, romFile], id: 1 } }));

  await waitForApplyButtonEnabled();
  const expectedGroup = () => document.getElementById("rom-weaver-rom-expected-checks");
  await waitForState(expectedGroup, 30000);
  await expect.poll(() => !!expectedGroup()?.querySelector(".ck-mark.bad"), { timeout: 30000 }).toBe(true);
  expect(expectedGroup().querySelector(".ck-mark.ok")).toBeNull();
});

test("bundle output verification stands down for partial selections and diverged chains", async () => {
  const [romFile, extraPatch, bundleArchive] = await Promise.all([
    loadFixtureFile(RAW_ROM),
    loadFixtureFile(RAW_PATCH),
    buildWithoutRomBundle({ outputCrc32: "00000000", romCrc32: ROM_CRC32 }),
  ]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive, romFile], id: 1 } }));

  // The optional patch seeds OFF, so the selection starts partial: the
  // bundle's expected output can't gate it and the calm notice says so.
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  const notice = await waitForState(() => document.getElementById("rom-weaver-bundle-output-unverified"), 30000);
  expect(notice.textContent).toContain("full patch chain");

  // Enabling the full authored chain re-engages verification: notice gone.
  getPatchToggles()[1]?.click();
  await expect
    .poll(() => document.getElementById("rom-weaver-bundle-output-unverified"), { timeout: 30000 })
    .toBeNull();

  // Appending a foreign patch diverges the chain: verification stands down
  // again, and the notice names the divergence instead of the selection.
  const foreignPatch = new File([await extraPatch.arrayBuffer()], "extra.ips", {
    type: "application/octet-stream",
  });
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), foreignPatch);
  const divergedNotice = await waitForState(
    () => document.getElementById("rom-weaver-bundle-output-unverified"),
    30000,
  );
  expect(divergedNotice.textContent).toContain("differs from the bundle");
});
