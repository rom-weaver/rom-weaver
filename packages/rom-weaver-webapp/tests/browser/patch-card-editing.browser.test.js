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
    options: { outputName, threads: 1 },
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
const buildWithoutRomBundle = async ({ romCrc32, outputCrc32, romName = "game.bin" }) => {
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
    rom: { checks: { checksums: { crc32: romCrc32 } }, name: romName },
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

test("pencil opens the inline meta editors; checks add/remove in the drawer; sharing stays below Apply", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [romFile, patchFile], id: 1 } }));
  await waitForApplyButtonEnabled();

  // Plain weave view: no inline editors yet; the sharing job is below Apply.
  expect(document.getElementById("rom-weaver-patch-name-0")).toBeNull();
  expect(document.getElementById("rom-weaver-patch-input-crc32-0")).toBeNull();
  expect(document.getElementById("rom-weaver-rom-bundle-crc32")).toBeNull();
  const bundleFormat = document.getElementById("rom-weaver-bundle-export-format");
  expect(bundleFormat).not.toBeNull();
  expect(bundleFormat.value).toBe("zip");
  expect(document.getElementById("rom-weaver-button-export-bundle")).not.toBeNull();

  // Compact patch cards must let the open menu escape the card's paint boundary.
  const patchMenuButton = document.getElementById("rom-weaver-patch-menu-0");
  patchMenuButton?.click();
  await expect.poll(() => document.querySelector("#rom-weaver-list-patch-stack .patch-menu-list")?.hidden).toBe(false);
  const metaControls = document.querySelector("#rom-weaver-list-patch-stack .patch-card-meta-controls");
  expect(metaControls?.inert).toBe(true);
  expect(getComputedStyle(patchMenuButton?.closest(".card") || document.body).contain).not.toContain("paint");

  // The pencil on the card opens the name/description editors in place; the
  // same control (now a check) closes them. No mode, no hash.
  document.getElementById("rom-weaver-patch-meta-edit-0")?.click();
  await expect.poll(() => document.getElementById("rom-weaver-patch-name-0")).not.toBeNull();
  expect(metaControls?.inert).toBe(false);
  expect(document.getElementById("rom-weaver-patch-description-0")).not.toBeNull();
  expect(document.getElementById("rom-weaver-patch-version-0")).not.toBeNull();
  expect(document.getElementById("rom-weaver-patch-author-0")).not.toBeNull();
  expect(window.location.hash).toBe("");
  document.getElementById("rom-weaver-patch-meta-edit-0")?.click();
  await expect.poll(() => document.getElementById("rom-weaver-patch-name-0")).toBeNull();

  // Expected checks live in the always-present Checks drawer: "Add check"
  // opens an editable field, its X removes it again.
  document.querySelector("#rom-weaver-list-patch-stack .cks-head")?.click();
  const addCheck = await waitForState(() => document.getElementById("rom-weaver-patch-input-add-check-0"));
  addCheck.value = "crc32";
  addCheck.dispatchEvent(new Event("change", { bubbles: true }));
  const crcInput = await waitForState(() => document.getElementById("rom-weaver-patch-input-crc32-0"));
  expect(crcInput).toBeInstanceOf(HTMLInputElement);
  expect(crcInput.readOnly).toBe(false);
  document.querySelector("#rom-weaver-list-patch-stack .ck-remove")?.click();
  await expect.poll(() => document.getElementById("rom-weaver-patch-input-crc32-0")).toBeNull();

  // The archive dropdown has no hide option, and the share action stays visible.
  expect(Array.from(bundleFormat.options, (option) => option.value)).toEqual(["zip", "7z"]);
});

test("bundle-renamed patch keeps its source file in the Files drawer", async () => {
  const [romFile, bundleArchive] = await Promise.all([
    loadFixtureFile(RAW_ROM),
    buildWithoutRomBundle({ romCrc32: ROM_CRC32 }),
  ]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive, romFile], id: 1 } }));
  await waitForApplyButtonEnabled();

  const filesDrawer = await waitForState(() => {
    const drawer = document.querySelector("#rom-weaver-list-patch-stack .extract-d");
    return drawer?.querySelector(".lab")?.textContent === "Files" ? drawer : null;
  });
  expect(filesDrawer).not.toBeNull();
  expect(document.querySelector("#rom-weaver-list-patch-stack .nm")?.textContent || "").toContain("Core");

  filesDrawer.querySelector(".cks-head")?.click();
  await expect
    .poll(() => Array.from(filesDrawer.querySelectorAll(".tree-name")).map((entry) => entry.textContent?.trim()))
    .toContain("change.ips");
});

test("bundle-expected ROM name and checks fold into the staged ROM card with match marks", async () => {
  const [romFile, bundleArchive] = await Promise.all([
    loadFixtureFile(RAW_ROM),
    buildWithoutRomBundle({ romCrc32: ROM_CRC32, romName: "GAME.BIN" }),
  ]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive, romFile], id: 1 } }));

  // The expected group unmounts while the ROM stages (its computed values are
  // pending), so settle the bench first, then re-query the live DOM per poll.
  await waitForApplyButtonEnabled();
  const expectedGroup = () => document.getElementById("rom-weaver-rom-expected-checks");
  await waitForState(expectedGroup, 30000);
  expect(expectedGroup().textContent).toContain("Expected");
  expect(expectedGroup().textContent).toContain("GAME.BIN");
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
  // The filename can match even when the checksum does not.
  expect(expectedGroup().querySelector(".ck-mark.ok")).not.toBeNull();
});

test("a ROM name mismatch warns without blocking weave", async () => {
  const [romFile, bundleArchive] = await Promise.all([
    loadFixtureFile(RAW_ROM),
    buildWithoutRomBundle({ romCrc32: ROM_CRC32, romName: "expected.bin" }),
  ]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive, romFile], id: 1 } }));

  await waitForApplyButtonEnabled();
  const expectedGroup = await waitForState(() => document.getElementById("rom-weaver-rom-expected-checks"), 30000);
  expect(expectedGroup.textContent).toContain("expected.bin");
  expect(expectedGroup.querySelector(".ck-mark.bad")).not.toBeNull();
  expect(document.querySelector(".expected-mismatch-info")).not.toBeNull();
  expect(document.getElementById("rom-weaver-button-apply")?.disabled).toBe(false);
});

test("bundle output verification stands down for partial selections and diverged chains", async () => {
  const [romFile, extraPatch, bundleArchive] = await Promise.all([
    loadFixtureFile(RAW_ROM),
    loadFixtureFile(RAW_PATCH),
    buildWithoutRomBundle({ outputCrc32: "00000000", romCrc32: ROM_CRC32 }),
  ]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive, romFile], id: 1 } }));

  // The optional patch seeds OFF, so the selection starts partial: the
  // bundle's expected output can't gate it, and it stands down silently
  // (a partial selection raises no notice).
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  await expect
    .poll(() => document.getElementById("rom-weaver-bundle-output-unverified"), { timeout: 30000 })
    .toBeNull();

  // Enabling the full authored chain keeps it quiet: still no notice.
  getPatchToggles()[1]?.click();
  await expect
    .poll(() => document.getElementById("rom-weaver-bundle-output-unverified"), { timeout: 30000 })
    .toBeNull();

  // Appending a foreign patch diverges the chain: now the notice appears and
  // names the divergence.
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

test("two freshly added checks hand off focus once each instead of trading it forever", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [romFile, patchFile], id: 1 } }));
  await waitForApplyButtonEnabled();

  document.getElementById("rom-weaver-patch-meta-edit-0")?.click();
  document.querySelector("#rom-weaver-list-patch-stack .cks-head")?.click();
  const addCheck = await waitForState(() => document.getElementById("rom-weaver-patch-input-add-check-0"));

  /* Each added row focuses itself through a ref callback, and a ref callback is
     re-invoked on every render. Count the focus() calls rather than the renders:
     two empty rows re-focusing would blur each other, and each blur commits and
     renders again. The cap keeps a regression a failed assertion instead of a
     hung browser. */
  const FOCUS_CAP = 25;
  // The saved method is called with each element as its receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const realFocus = HTMLElement.prototype.focus;
  let focusCalls = 0;
  HTMLElement.prototype.focus = function countedFocus(...args) {
    focusCalls += 1;
    if (focusCalls > FOCUS_CAP) return undefined;
    return realFocus.apply(this, args);
  };
  try {
    for (const field of ["md5", "sha1"]) {
      addCheck.value = field;
      addCheck.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForState(() => document.getElementById(`rom-weaver-patch-input-${field}-0`));
    }
    // Let any pending commit/render cascade settle before sampling the count.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    HTMLElement.prototype.focus = realFocus;
  }

  expect(focusCalls).toBeLessThanOrEqual(FOCUS_CAP);
  // One deliberate hand-off per row, and both rows survive.
  expect(focusCalls).toBeLessThanOrEqual(4);
  expect(document.getElementById("rom-weaver-patch-input-md5-0")).not.toBeNull();
  expect(document.getElementById("rom-weaver-patch-input-sha1-0")).not.toBeNull();
});
