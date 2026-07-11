import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickPatchCandidateSelectionOption,
  getCandidateSelectionList,
  getPatchStackFileNames,
  getPatchStackRows,
  getRuntimeErrorText,
  installPatcherTestHooks,
  loadFixtureFile,
  MULTI_PATCH_ZIP,
  mount,
  NESTED_BUNDLE_ZIP,
  NESTED_CHAIN_ZIP,
  NESTED_ROOT_ZIP,
  ONE_PATCH_7Z,
  RAW_ROM,
  selectFileInput,
  selectPatchCandidates,
  waitForApplyButtonEnabled,
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

test("patch row shows extraction progress and extracted patch naming", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
    await loadFixtureFile(ONE_PATCH_7Z, "application/x-7z-compressed"),
  );

  await clickPatchCandidateSelectionOption("change.ips");

  const patchState = await waitForState(() => {
    const patchFileName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file")?.textContent || "";
    const selectedPatchName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "";
    if (selectedPatchName.includes("change.ips") || patchFileName === "change.ips") return { kind: "ready" };
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(patchState).not.toBeNull();
  expect(patchState?.kind, patchState && "errorText" in patchState ? patchState.errorText : "").toBe("ready");

  await expect
    .poll(
      () =>
        document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "",
      { timeout: 30000 },
    )
    .toContain("change.ips");

  const archiveLabel =
    document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-archive")?.textContent || "";
  expect(archiveLabel).toContain("one-patch.7z");
  expect(archiveLabel).toContain("change.ips");
  expect(archiveLabel).toMatch(/\d+(?:\.\d)? (?:B|KB|MB|GB|TB)/);
  expect(
    document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-archive strong")?.textContent || "",
  ).toContain("change.ips");
});

test("deleting a selected patch archive requires selection again when re-added", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  const patchArchive = await loadFixtureFile(MULTI_PATCH_ZIP, "application/zip");
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), patchArchive);
  await clickPatchCandidateSelectionOption("change.ips");

  await expect
    .poll(
      () =>
        document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "",
      { timeout: 30000 },
    )
    .toContain("change.ips");

  const removeButton = document.querySelector("#rom-weaver-list-patch-stack button[aria-label='Remove patch']");
  if (!(removeButton instanceof HTMLButtonElement)) throw new Error("Missing remove patch button");
  removeButton.click();

  await expect
    .poll(() => !document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file"), {
      timeout: 30000,
    })
    .toBe(true);

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), patchArchive);

  await expect.poll(() => !!getCandidateSelectionList(), { timeout: 30000 }).toBe(true);
});

test("re-uploading the same patch archive can add a second different patch", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  // Two distinct File objects with an identical signature (name/size/lastModified), exactly as
  // the OS file picker produces when the same file is chosen twice.
  const archiveBytes = await (await fetch("/tests/fixtures/archives/multi-patch.7z")).arrayBuffer();
  const makePatchArchive = () =>
    new File([archiveBytes], "multi-patch.7z", { lastModified: 1700000000000, type: "application/x-7z-compressed" });

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), makePatchArchive());
  await clickPatchCandidateSelectionOption("change.ips");

  await expect.poll(() => getPatchStackRows().length, { timeout: 30000 }).toBe(1);

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), makePatchArchive());
  await expect.poll(() => !!getCandidateSelectionList(), { timeout: 30000 }).toBe(true);
  await clickPatchCandidateSelectionOption("alternate.ips");

  await expect
    .poll(() => getPatchStackFileNames(), { timeout: 30000 })
    .toEqual(expect.arrayContaining(["change.ips", "alternate.ips"]));
  const labels = getPatchStackRows()
    .map((row) => row.textContent || "")
    .join("|");
  expect(labels).toContain("change.ips");
  expect(labels).toContain("alternate.ips");
  const errorText = getRuntimeErrorText();
  expect(errorText, errorText).toBe("");
});

test("nested patch bundle lists every branch patch and multi-selects into separate stack entries", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
    await loadFixtureFile(NESTED_BUNDLE_ZIP, "application/zip"),
  );

  const listText = () => getCandidateSelectionList()?.textContent || "";
  await expect.poll(listText, { timeout: 60000 }).toContain("patchB1.ips");
  expect(listText()).toContain("patchB2.ips");
  expect(listText()).toContain("patchB3.ips");

  await selectPatchCandidates(["patchB1.ips", "patchB2.ips"]);

  await expect.poll(() => getPatchStackFileNames().length, { timeout: 60000 }).toBe(2);
  const names = getPatchStackFileNames();
  expect(names).toContain("patchB1.ips");
  expect(names).toContain("patchB2.ips");
  expect(getRuntimeErrorText()).toBeFalsy();
});

test("nested patch archive distinguishes sibling patches in the same branch", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
    await loadFixtureFile(NESTED_ROOT_ZIP, "application/zip"),
  );

  const listText = () => getCandidateSelectionList()?.textContent || "";
  await expect.poll(listText, { timeout: 60000 }).toContain("flat1.ips");
  expect(listText()).toContain("flat2.ips");
  expect(listText()).toContain("deep.ips");

  // flat1.ips and flat2.ips are two distinct patches inside the SAME nested branch, so each must be
  // addressable individually (a single branch selection could not distinguish them).
  await selectPatchCandidates(["flat1.ips", "flat2.ips"]);

  await expect.poll(() => getPatchStackFileNames().length, { timeout: 60000 }).toBe(2);
  expect(getPatchStackFileNames()).toEqual(expect.arrayContaining(["flat1.ips", "flat2.ips"]));
  expect(getRuntimeErrorText()).toBeFalsy();
});

test("deeply nested single patch auto-selects without a selection dialog", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
    await loadFixtureFile(NESTED_CHAIN_ZIP, "application/zip"),
  );

  await expect.poll(() => getPatchStackFileNames().length, { timeout: 60000 }).toBe(1);
  expect(getPatchStackFileNames()[0]).toContain("levelA.ips");
  expect(getCandidateSelectionList()).toBeNull();
  expect(getRuntimeErrorText()).toBeFalsy();
});

test("adding an input after a staged patch does not reshow preparing patch progress", async () => {
  const progressEvents = [];
  mount(
    createElement(ApplyPatchForm, {
      onProgress: (event) => {
        progressEvents.push(event);
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-unified"),
    await loadFixtureFile(ONE_PATCH_7Z, "application/x-7z-compressed"),
  );
  await clickPatchCandidateSelectionOption("change.ips");

  await expect
    .poll(
      () =>
        document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "",
      { timeout: 30000 },
    )
    .toContain("change.ips");

  progressEvents.length = 0;

  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(RAW_ROM));
  await waitForApplyButtonEnabled();

  const patchPreparingEvents = progressEvents.filter((event) => {
    const role = String(event?.details?.role || "");
    const label = String(event?.label || "");
    return role === "patch" && /preparing patch/i.test(label);
  });
  expect(patchPreparingEvents).toHaveLength(0);

  const patchExtractEvents = progressEvents.filter((event) => {
    const details = event?.details || {};
    return String(details.role || "") === "patch" && String(details.stage || "") === "extract";
  });
  expect(patchExtractEvents).toHaveLength(0);
});
