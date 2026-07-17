import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { installPatcherTestHooks, loadFixtureFile, mount, RAW_ROM, selectFileInput } from "./patcher-test-shared.js";

installPatcherTestHooks();

// A true BPS chain built from the 13-byte game.bin: a = base -> inter,
// b = inter -> final, c = final -> final2. d is a SIBLING of a: also
// authored straight against the base (base -> alt).
const CHAIN_A = "tests/fixtures/browser-generated/chain-step-a.bps";
const CHAIN_B = "tests/fixtures/browser-generated/chain-step-b.bps";
const CHAIN_C = "tests/fixtures/browser-generated/chain-step-c.bps";
const SAME_BASE_D = "tests/fixtures/browser-generated/chain-step-d.bps";

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

test("an out-of-order chain names its predecessor and Fix order repairs it", async () => {
  mount(createElement(ApplyPatchForm, {}));
  // c expects b's output but is listed before b.
  await dropFixtures([RAW_ROM, CHAIN_A, CHAIN_C, CHAIN_B]);

  await expect.poll(() => chipText(1), { timeout: 60000 }).toContain("expects patch 3 first");
  await expect
    .poll(() => document.getElementById("rom-weaver-patch-order-note")?.textContent ?? "", { timeout: 60000 })
    .toContain("woven first");
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
