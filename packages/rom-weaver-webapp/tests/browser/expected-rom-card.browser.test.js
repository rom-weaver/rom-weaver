import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { installPatcherTestHooks, loadFixtureFile, mount, RAW_PATCH, VALID_BPS } from "./patcher-test-shared.js";

installPatcherTestHooks();

const EXPECTED_CARD = "#rom-weaver-bundle-rom-expectation";

const getExpectationCard = () => document.querySelector(EXPECTED_CARD);
const getHashForm = () => document.getElementById("rom-weaver-rom-hash-search");
const getHashInput = () => document.getElementById("rom-weaver-rom-hash");
const getHashError = () => document.querySelector("#rom-weaver-rom-hash-search .identify-hash-error");

const getExpectationChecks = () =>
  Array.from(document.querySelectorAll(`${EXPECTED_CARD} .ck`)).map((row) =>
    [row.querySelector(".ck-k")?.textContent || "", row.querySelector(".ck-v")?.textContent || ""].join(" "),
  );

// React tracks the input's value through the prototype setter, so assigning
// `input.value` directly leaves its onChange unfired and the state stale.
const submitHash = (value) => {
  const input = getHashInput();
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  getHashForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};

test("a checks-only bundle shows the expected ROM before one is staged", async () => {
  const patchFile = await loadFixtureFile(RAW_PATCH);
  const bundleJson = {
    output: { name: "bundled-output" },
    patches: [{ name: "Core", path: "change.ips" }],
    rom: { checks: { checksums: { crc32: "d7ae93df" }, size: 1024 }, name: "game.bin" },
    version: 1,
  };
  const bundleFile = new File([JSON.stringify(bundleJson)], "rom-weaver-bundle.json", { type: "application/json" });

  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleFile, patchFile], id: 1 } }));

  await expect.poll(() => getExpectationCard()?.textContent || "", { timeout: 30000 }).toContain("game.bin");
  expect(getExpectationCard().textContent).toContain("provide it yourself");
  const checks = getExpectationChecks();
  expect(checks.some((row) => row.includes("d7ae93df"))).toBe(true);
  expect(checks.some((row) => row.includes("1024"))).toBe(true);
  // The bundle already answers "which ROM do I need", so the checksum search
  // stays away rather than offering a second, possibly conflicting answer.
  expect(getHashForm()).toBeNull();
});

// The check does not have to come from a bundle: a patch that declares its
// source ROM is a rom check too, and raises the same card.
test("a patch's declared source ROM shows the expected ROM card", async () => {
  const patchFile = await loadFixtureFile(VALID_BPS);

  mount(createElement(ApplyPatchForm, { pageDrop: { files: [patchFile], id: 1 } }));

  await expect.poll(() => getExpectationCard()?.textContent || "", { timeout: 30000 }).toContain("Expected ROM");
  expect(getExpectationCard().textContent).toContain("Expected by a patch");
  expect(getExpectationChecks().length).toBeGreaterThan(0);
});

/* The lookup's own answers are covered in tests/unit/hooks/rom-hash-lookup.ts,
   where the seam can be stubbed. Mocking a module here would make Vitest
   re-instrument the whole apply import graph, which deadlocks the browser
   runner under its normal concurrency - so this file stays mock-free and
   asserts only what needs a real page: the control, and the validation that
   happens before any lookup. */
test("the empty apply page offers a checksum search that validates before looking up", async () => {
  mount(createElement(ApplyPatchForm, {}));

  await expect.poll(() => !!getHashForm(), { timeout: 30000 }).toBe(true);
  expect(getHashForm().textContent).toContain("Looking for a specific ROM checksum?");
  expect(getHashInput().placeholder).toBe("crc32 / md5 / sha1");
  expect(document.querySelector(".ghost-steps")).not.toBeNull();

  submitHash("zzzz");
  await expect.poll(() => getHashError()?.textContent || "", { timeout: 30000 }).toContain("hex characters");
  submitHash("abc");
  await expect.poll(() => getHashError()?.textContent || "", { timeout: 30000 }).toContain("8 (CRC32)");
  expect(getExpectationCard()).toBeNull();
});
