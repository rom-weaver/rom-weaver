import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { installPatcherTestHooks, loadFixtureFile, mount, RAW_PATCH, VALID_BPS } from "./patcher-test-shared.js";

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
