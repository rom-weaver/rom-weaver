import { createElement } from "react";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_ROM,
  selectFileInput,
  setFormControlValue,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

afterEach(async () => page.viewport(1280, 900));

// A true BPS chain built from the 13-byte game.bin: a = base -> inter,
// b = inter -> final, c = final -> final2. d is a SIBLING of a: also
// authored straight against the base (base -> alt).
const CHAIN_A = "tests/fixtures/browser-generated/chain-step-a.bps";
const CHAIN_B = "tests/fixtures/browser-generated/chain-step-b.bps";
const CHAIN_C = "tests/fixtures/browser-generated/chain-step-c.bps";
const SAME_BASE_D = "tests/fixtures/browser-generated/chain-step-d.bps";

// Two checksumless IPS patches, each an alternative edit of game.bin. IPS carries no source
// checksum, so the planner has no evidence either is chained.
const IPS_ALT_A = "tests/fixtures/archive_sources/multi-patch/change.ips";
const IPS_ALT_B = "tests/fixtures/archive_sources/multi-patch/alternate.ips";

// game.bin's raw crc32 (both base-authored patches embed it as their source).
const ROM_CRC32 = "c6fb1252";

const chipText = (index) => document.getElementById(`rom-weaver-patch-chain-chip-${index}`)?.textContent?.trim() ?? "";

const dropFixtures = async (paths) => {
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  for (const path of paths) {
    selectFileInput(document.getElementById("rom-weaver-input-file-unified"), await loadFixtureFile(path));
    // Outrun the staging coalescing window so list order follows drop order.
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
};

const getPatchInputSelect = async (index) => {
  const findSelect = () => document.getElementById(`rom-weaver-patch-basis-${index}`);
  await expect.poll(findSelect).toBeInstanceOf(HTMLSelectElement);
  return findSelect();
};

const patchCheckHeadings = (index) => {
  const card = [...document.querySelectorAll("#rom-weaver-list-patch-stack .card.patch")][index];
  return [...(card?.querySelectorAll(".ck-group-head") || [])].map((head) => head.textContent?.trim());
};

test("a true BPS chain defers the dependent patch instead of failing it", async () => {
  mount(createElement(ApplyPatchForm, {}));
  await dropFixtures([RAW_ROM, CHAIN_A, CHAIN_B]);

  // The chain head verifies against the ROM; the dependent patch is deferred
  // with its link named - never dry-run against the wrong bytes.
  await expect.poll(() => chipText(0), { timeout: 60000 }).toBe("Verified — game.bin");
  await expect.poll(() => chipText(1), { timeout: 60000 }).toBe("Checks during apply — chain-step-a.bps");
  const basisSelect = await getPatchInputSelect(1);
  expect(basisSelect.options[0]?.textContent).toBe("auto (Previous patch output)");
  expect(basisSelect.getAttribute("aria-describedby")).toBe("rom-weaver-patch-checks-help-1");
  expect(patchCheckHeadings(0)).toEqual([
    "Authored input checks — Original ROM (automatic)",
    "Embedded output checks — Standalone patch result",
    "Stack output checks — Combined result",
    "Shared input checks — Original ROM",
  ]);
  expect(patchCheckHeadings(1)).toEqual([
    "Authored input checks — Previous patch output (automatic)",
    "Embedded output checks — Standalone patch result",
    "Stack output checks — Combined result",
  ]);
  expect(document.querySelector(`#rom-weaver-patch-checks-help-1`)?.textContent).toContain(
    "Authored input checks describe a patch source.",
  );
  await page.viewport(390, 844);
  const chainChip = document.getElementById("rom-weaver-patch-chain-chip-1");
  expect(getComputedStyle(chainChip?.closest(".rb") || document.body).flexShrink).toBe("1");
  const cardMeta = basisSelect.closest(".card-meta");
  expect(cardMeta?.scrollWidth).toBeLessThanOrEqual(cardMeta?.clientWidth ?? 0);
  expect(document.querySelector("#rom-weaver-list-patch-stack .file.bad")).toBeNull();
  expect(document.getElementById("rom-weaver-patch-order-note")).toBeNull();

  // An exact statically-proven chain makes the last patch's embedded target
  // enforceable: the output line stands down with no "won't be verified" warning.
  await expect
    .poll(() => document.getElementById("rom-weaver-bundle-output-unverified"), { timeout: 60000 })
    .toBeNull();
});

test("same-base patches all match the ROM and feed the Expected group without conflict", async () => {
  mount(createElement(ApplyPatchForm, {}));
  await dropFixtures([RAW_ROM, CHAIN_A, SAME_BASE_D]);

  // Both patches were authored against the base: each one verifies against
  // the ROM directly instead of chaining off its neighbor.
  await expect.poll(() => chipText(0), { timeout: 60000 }).toBe("Verified — game.bin");
  await expect.poll(() => chipText(1), { timeout: 60000 }).toBe("Verified — game.bin");
  expect(document.getElementById("rom-weaver-patch-order-note")).toBeNull();

  // Their shared base expectation unions into the ROM card's Expected group
  // (one agreeing crc32 row, verified mark, no conflict notice).
  const expectedGroup = () => document.getElementById("rom-weaver-rom-expected-checks");
  await expect.poll(() => expectedGroup()?.textContent ?? "", { timeout: 60000 }).toContain(ROM_CRC32);
  await expect.poll(() => !!expectedGroup()?.querySelector(".ck-mark.ok"), { timeout: 60000 }).toBe(true);
  expect(expectedGroup()?.querySelector(".ck-mark.bad")).toBeNull();
  expect(document.getElementById("rom-weaver-rom-expected-conflict")).toBeNull();
}, 120000);

test("checksumless patches distinguish successful preflight from verified identity", async () => {
  mount(createElement(ApplyPatchForm, {}));
  await dropFixtures([RAW_ROM, IPS_ALT_A, IPS_ALT_B]);

  // A successful preflight is a verified check even when its patch carries no source checksum.
  const passedChecks = () =>
    document.querySelectorAll('#rom-weaver-list-patch-stack button[title="Preflight passed"]').length;
  await expect.poll(passedChecks, { timeout: 60000 }).toBe(2);
  await expect.poll(() => chipText(1), { timeout: 60000 }).toBe("Verified — game.bin");
  expect(document.querySelector("#rom-weaver-list-patch-stack .file.bad")).toBeNull();
}, 120000);

test("a patch input selector re-plans that patch", async () => {
  mount(createElement(ApplyPatchForm, {}));
  await dropFixtures([RAW_ROM, CHAIN_A, SAME_BASE_D]);
  await expect.poll(() => chipText(1), { timeout: 60000 }).toBe("Verified — game.bin");

  const basisSelect = await getPatchInputSelect(1);
  expect(basisSelect.value).toBe("auto");
  expect(basisSelect.options[0]?.textContent).toBe("auto (Original ROM)");

  // Pinning "previous output" overrides the inference: the re-plan stops
  // verifying this patch against the ROM and defers it to apply (where the
  // real intermediate decides).
  setFormControlValue(basisSelect, "previous");
  await expect.poll(() => chipText(1), { timeout: 90000 }).toBe("Checks during apply — game.bin");
  expect(patchCheckHeadings(1)).toEqual([
    "Authored input checks — Previous patch output",
    "Embedded output checks — Standalone patch result",
    "Stack output checks — Combined result",
  ]);

  // Return to automatic detection.
  setFormControlValue(document.getElementById("rom-weaver-patch-basis-1"), "auto");
  await expect.poll(() => chipText(1), { timeout: 90000 }).toBe("Verified — game.bin");
  expect(patchCheckHeadings(1)).toEqual([
    "Authored input checks — Original ROM (automatic)",
    "Embedded output checks — Standalone patch result",
    "Stack output checks — Combined result",
    "Shared input checks — Original ROM",
  ]);
}, 180000);

test("a Previous basis pin reaches Apply execution", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: { validation: { requireInputChecksumMatch: true } },
    }),
  );
  await dropFixtures([RAW_ROM, CHAIN_A, SAME_BASE_D]);
  await expect.poll(() => chipText(1), { timeout: 60000 }).toBe("Verified — game.bin");

  // The sibling patch is base-authored. Pinning it to Previous must reach the
  // real apply command, which then checks it against patch 1's intermediate
  // and rejects that checksum. If execution drops the pin, inference chooses
  // base and the same run incorrectly succeeds.
  setFormControlValue(await getPatchInputSelect(1), "previous");
  await expect.poll(() => chipText(1), { timeout: 90000 }).toBe("Checks during apply — game.bin");
  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const outcome = await waitForApplyOutcome();
  expect(outcome?.kind).toBe("error");
  expect(outcome && "errorText" in outcome ? outcome.errorText : "").toMatch(/checksum/i);
}, 180000);

test("changing a patch input retires a completed output", async () => {
  mount(createElement(ApplyPatchForm, {}));
  await dropFixtures([RAW_ROM, CHAIN_A, CHAIN_B]);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });

  setFormControlValue(await getPatchInputSelect(1), "base");
  await expect
    .poll(() => document.getElementById("rom-weaver-button-apply")?.getAttribute("aria-label"), { timeout: 30000 })
    .toBeNull();
}, 180000);

test("an out-of-order chain names its predecessor and Fix order repairs it", async () => {
  mount(createElement(ApplyPatchForm, {}));
  // c expects b's output but is listed before b.
  await dropFixtures([RAW_ROM, CHAIN_A, CHAIN_C, CHAIN_B]);

  await expect.poll(() => chipText(1), { timeout: 60000 }).toBe("⚠ Requires chain-step-b.bps first");
  await expect
    .poll(() => document.getElementById("rom-weaver-patch-order-note")?.textContent ?? "", { timeout: 60000 })
    .toContain("applied first");
  // The broken chain also stands down output verification, naming the order problem.
  await expect
    .poll(() => document.getElementById("rom-weaver-bundle-output-unverified")?.textContent ?? "", { timeout: 60000 })
    .toContain("out of order");

  const fixButton = document.getElementById("rom-weaver-button-fix-patch-order");
  expect(fixButton).toBeInstanceOf(HTMLButtonElement);
  fixButton.click();

  // The repaired chain re-plans: every link resolves and the note stands down.
  await expect.poll(() => chipText(1), { timeout: 90000 }).toBe("Checks during apply — chain-step-a.bps");
  await expect.poll(() => chipText(2), { timeout: 90000 }).toBe("Checks during apply — chain-step-b.bps");
  await expect.poll(() => document.getElementById("rom-weaver-patch-order-note"), { timeout: 60000 }).toBeNull();
  // ...and the output line stands down: no "won't be verified" warning remains.
  await expect
    .poll(() => document.getElementById("rom-weaver-bundle-output-unverified"), { timeout: 60000 })
    .toBeNull();
}, 180000);
