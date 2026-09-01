import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { installPatcherTestHooks, loadFixtureFile, mount, RAW_PATCH, VALID_BPS } from "./patcher-test-shared.js";

// Only the checksum lookup is stubbed; the apply workflow keeps the real
// browser API, because the card it raises is part of that workflow.
const { identifyChecks } = vi.hoisted(() => ({ identifyChecks: vi.fn() }));
vi.mock("../../src/platform/browser/browser-api.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  identifyChecks,
}));

installPatcherTestHooks();

const EXPECTED_CARD = "#rom-weaver-bundle-rom-expectation";

const getExpectationCard = () => document.querySelector(EXPECTED_CARD);

const getExpectationChecks = () =>
  Array.from(document.querySelectorAll(`${EXPECTED_CARD} .ck`)).map((row) =>
    [row.querySelector(".ck-k")?.textContent || "", row.querySelector(".ck-v")?.textContent || ""].join(" "),
  );

// The identify packs are not served in the browser test runtime, so the lookup
// resolves to "no identify data". The card must still render the check itself -
// a checksum nobody can look up is not a check that failed.
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
  expect(getExpectationCard()?.textContent || "").toContain("provide it yourself");
  const checks = getExpectationChecks();
  expect(checks.some((row) => row.includes("d7ae93df"))).toBe(true);
  expect(checks.some((row) => row.includes("1024"))).toBe(true);
});

// The check does not have to come from a bundle: a patch that declares its
// source ROM is a rom check too, and raises the same card.
test("a patch's declared source ROM shows the expected ROM card", async () => {
  const patchFile = await loadFixtureFile(VALID_BPS);

  mount(createElement(ApplyPatchForm, { pageDrop: { files: [patchFile], id: 1 } }));

  await expect.poll(() => getExpectationCard()?.textContent || "", { timeout: 30000 }).toContain("Expected ROM");
  expect(getExpectationCard()?.textContent || "").toContain("Expected by a patch");
  expect(getExpectationChecks().length).toBeGreaterThan(0);
});

const getHashForm = () => document.getElementById("rom-weaver-rom-hash-search");
const getHashInput = () => document.getElementById("rom-weaver-rom-hash");
const getHashError = () => document.querySelector("#rom-weaver-rom-hash-search .identify-hash-error");

// React tracks the input's value through the prototype setter, so assigning
// `input.value` directly leaves its onChange unfired and the state stale.
const submitHash = (value) => {
  const input = getHashInput();
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  getHashForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};

/* An IPS carries no source checksum, so nothing in the run says which ROM it
   targets - the case the checksum search exists for. */
const mountWithBareIps = async () => {
  const patchFile = await loadFixtureFile(RAW_PATCH);
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [patchFile], id: 1 } }));
  await expect.poll(() => !!getHashForm(), { timeout: 30000 }).toBe(true);
};

test("a run with no declared ROM offers a checksum search", async () => {
  await mountWithBareIps();

  expect(getHashForm().textContent).toContain("Identify by checksum");
  expect(getHashInput().placeholder).toBe("crc32 / md5 / sha1");
});

test("a malformed checksum is rejected without a lookup", async () => {
  await mountWithBareIps();

  submitHash("zzzz");
  await expect.poll(() => getHashError()?.textContent || "", { timeout: 30000 }).toContain("hex characters");

  submitHash("abc");
  await expect.poll(() => getHashError()?.textContent || "", { timeout: 30000 }).toContain("8 (CRC32)");
});

const hashCandidate = (hash, status, matches) => ({
  candidates: [{ checksumVariants: [], checksums: { crc32: hash }, matches, path: hash, status }],
  input: hash,
  status,
});

const MATCH = {
  algorithm: "components",
  database: "test-system.pack",
  expectedComponents: [
    {
      crc32: "d7ae93df",
      md5: "5d41402abc4b2a76b9719d911017c592",
      ordinal: 0,
      role: "primary_payload",
      sha1: "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
      size: 1024,
    },
  ],
  name: "Hello World (USA)",
  platform: "Test System",
  region: "USA",
  revision: "Rev 1",
  variant: "manual",
};

test("a pasted checksum raises the expected ROM card", async () => {
  identifyChecks.mockResolvedValue(hashCandidate("d7ae93df", "matched", [MATCH]));
  await mountWithBareIps();

  submitHash("D7AE93DF");
  await expect.poll(() => getExpectationCard()?.textContent || "", { timeout: 30000 }).toContain("Hello World (USA)");

  expect(identifyChecks).toHaveBeenCalledWith({ checksums: { crc32: "d7ae93df" } }, expect.anything());
  expect(getExpectationCard().textContent).toContain("Found by checksum");
  const checks = getExpectationChecks();
  // The pasted value is the expectation; the rest comes from the database.
  expect(checks.some((row) => row.includes("d7ae93df"))).toBe(true);
  expect(checks.some((row) => row.includes("5d41402abc4b2a76b9719d911017c592"))).toBe(true);
  expect(checks.some((row) => row.includes("1024"))).toBe(true);
  expect(getExpectationCard().textContent).toContain("From the database");
});

test("a checksum no ROM has is reported without a card", async () => {
  identifyChecks.mockResolvedValue(hashCandidate("deadbeef", "unknown", []));
  await mountWithBareIps();

  submitHash("deadbeef");
  await expect.poll(() => getHashError()?.textContent || "", { timeout: 30000 }).toContain("No ROM");
  expect(getExpectationCard()).toBeNull();
});

test("missing identify data is reported as unavailable, not as no match", async () => {
  identifyChecks.mockResolvedValue({
    candidates: [{ checksumVariants: [], checksums: {}, matches: [], path: "d7ae93df", status: "unavailable" }],
    input: "d7ae93df",
    status: "unavailable",
  });
  await mountWithBareIps();

  submitHash("d7ae93df");
  await expect.poll(() => getHashError()?.textContent || "", { timeout: 30000 }).toContain("not available");
  expect(getExpectationCard()).toBeNull();
});

// A bundle or patch already answers "which ROM do I need", so the search stays
// out of the way rather than offering a second, conflicting answer.
test("a bundle's own rom check hides the checksum search", async () => {
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
  expect(getHashForm()).toBeNull();
});
