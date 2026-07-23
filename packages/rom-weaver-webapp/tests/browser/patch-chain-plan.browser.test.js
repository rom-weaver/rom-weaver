import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_ROM,
  selectFileInput,
  setFormControlValue,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

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

test("a true BPS chain defers the dependent patch instead of failing it", async () => {
  mount(createElement(ApplyPatchForm, {}));
  await dropFixtures([RAW_ROM, CHAIN_A, CHAIN_B]);

  // The chain head verifies against the ROM; the dependent patch is deferred
  // with its link named - never dry-run against the wrong bytes.
  await expect.poll(() => chipText(0), { timeout: 60000 }).toBe("matches your ROM");
  await expect.poll(() => chipText(1), { timeout: 60000 }).toBe("applies after patch 1");
  expect(document.querySelector("#rom-weaver-list-patch-stack .file.bad")).toBeNull();
  expect(document.getElementById("rom-weaver-patch-order-note")).toBeNull();

  // An exact statically-proven chain makes the last patch's embedded target
  // enforceable: the output line reassures instead of warning.
  await expect.poll(() => document.getElementById("rom-weaver-output-verified"), { timeout: 60000 }).not.toBeNull();
  expect(document.getElementById("rom-weaver-bundle-output-unverified")).toBeNull();
});

test("same-base patches all match the ROM and feed the Expected group without conflict", async () => {
  mount(createElement(ApplyPatchForm, {}));
  await dropFixtures([RAW_ROM, CHAIN_A, SAME_BASE_D]);

  // Both patches were authored against the base: each one verifies against
  // the ROM directly instead of chaining off its neighbor.
  await expect.poll(() => chipText(0), { timeout: 60000 }).toBe("matches your ROM");
  await expect.poll(() => chipText(1), { timeout: 60000 }).toBe("matches your ROM");
  expect(document.getElementById("rom-weaver-patch-order-note")).toBeNull();

  // Their shared base expectation unions into the ROM card's Expected group
  // (one agreeing crc32 row, verified mark, no conflict notice).
  const expectedGroup = () => document.getElementById("rom-weaver-rom-expected-checks");
  await expect.poll(() => expectedGroup()?.textContent ?? "", { timeout: 60000 }).toContain(ROM_CRC32);
  await expect.poll(() => !!expectedGroup()?.querySelector(".ck-mark.ok"), { timeout: 60000 }).toBe(true);
  expect(expectedGroup()?.querySelector(".ck-mark.bad")).toBeNull();
  expect(document.getElementById("rom-weaver-rom-expected-conflict")).toBeNull();
}, 120000);

test("checksumless patches with no evidence each verify against the ROM regardless of position", async () => {
  mount(createElement(ApplyPatchForm, {}));
  await dropFixtures([RAW_ROM, IPS_ALT_A, IPS_ALT_B]);

  // Both IPS patches apply cleanly to the ROM. With no checksum to tie either to the other's
  // output, neither has any more claim to being "chained" than the head does - so both verify
  // green against the base. Before the fix the second patch read "verified during apply"
  // purely for being listed second (an empty promise: IPS has nothing to verify during apply).
  const passedChecks = () =>
    document.querySelectorAll('#rom-weaver-list-patch-stack button[title="Preflight passed"]').length;
  await expect.poll(passedChecks, { timeout: 60000 }).toBe(2);
  expect(chipText(1)).not.toBe("verified during apply");
  expect(document.querySelector("#rom-weaver-list-patch-stack .file.bad")).toBeNull();
}, 120000);

test("the basis select names the inferred basis and a pin re-plans the chain", async () => {
  mount(createElement(ApplyPatchForm, {}));
  await dropFixtures([RAW_ROM, CHAIN_A, SAME_BASE_D]);
  await expect.poll(() => chipText(1), { timeout: 60000 }).toBe("matches your ROM");

  // The select's auto option names what inference resolved.
  const basisSelect = document.getElementById("rom-weaver-patch-basis-1");
  expect(basisSelect).toBeInstanceOf(HTMLSelectElement);
  expect(basisSelect.value).toBe("");
  expect(basisSelect.options[0]?.textContent).toBe("auto (base ROM)");

  // Pinning "previous output" overrides the inference: the re-plan stops
  // verifying this patch against the ROM and defers it to apply (where the
  // real intermediate decides).
  setFormControlValue(basisSelect, "previous");
  await expect.poll(() => chipText(1), { timeout: 90000 }).toBe("verified during apply");

  // Back to auto: inference decides again and the chip recovers.
  setFormControlValue(document.getElementById("rom-weaver-patch-basis-1"), "");
  await expect.poll(() => chipText(1), { timeout: 90000 }).toBe("matches your ROM");
}, 180000);

test("an out-of-order chain names its predecessor and Fix order repairs it", async () => {
  mount(createElement(ApplyPatchForm, {}));
  // c expects b's output but is listed before b.
  await dropFixtures([RAW_ROM, CHAIN_A, CHAIN_C, CHAIN_B]);

  await expect.poll(() => chipText(1), { timeout: 60000 }).toContain("expects patch 3 first");
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
  await expect.poll(() => chipText(1), { timeout: 90000 }).toBe("applies after patch 1");
  await expect.poll(() => chipText(2), { timeout: 90000 }).toBe("applies after patch 2");
  await expect.poll(() => document.getElementById("rom-weaver-patch-order-note"), { timeout: 60000 }).toBeNull();
  // ...and the output line flips to the verified reassurance.
  await expect.poll(() => document.getElementById("rom-weaver-output-verified"), { timeout: 60000 }).not.toBeNull();
  expect(document.getElementById("rom-weaver-bundle-output-unverified")).toBeNull();
}, 180000);
