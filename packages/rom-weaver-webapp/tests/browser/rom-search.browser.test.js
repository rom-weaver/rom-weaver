import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "../../src/webapp/design-system/index.css";
// deferred.css ships lazily in production (webapp.ts loads it at boot); the
// drawers the expectation card renders come from it.
import "../../src/webapp/design-system/deferred.css";

/* The identify data seam every route shares. Stubbing it drives the search's
   real DOM and real stylesheets without the wasm runtime. Mounting the whole
   apply form here instead would make Vitest re-instrument its import graph,
   which deadlocks the browser runner (see expected-rom-card.browser.test.js). */
const { lookupExpectedRom, searchExpectedRomByName, searchExpectedRomTitles } = vi.hoisted(() => ({
  lookupExpectedRom: vi.fn(),
  searchExpectedRomByName: vi.fn(),
  searchExpectedRomTitles: vi.fn(),
}));
vi.mock("../../src/lib/apply/expected-rom-lookup.ts", () => ({
  lookupExpectedRom,
  searchExpectedRomByName,
  searchExpectedRomTitles,
}));

const { ROM_LOOKUP_MESSAGES, RomExpectationCard, RomSearch } =
  await import("../../src/public/react/components/ds/rom-expectation-card.tsx");
const { useRomLookup } = await import("../../src/public/react/use-rom-lookup.ts");
const { useUiLocalizer } = await import("../../src/public/react/settings-context.tsx");

const FUSION = { name: "Metroid Fusion", platform: "Nintendo - Game Boy Advance", slug: "nintendo-game-boy-advance" };
const ZERO_MISSION = {
  name: "Metroid - Zero Mission",
  platform: "Nintendo - Game Boy Advance",
  slug: "nintendo-game-boy-advance",
};
const PRIME = { name: "Metroid Prime", platform: "Nintendo - GameCube", slug: "nintendo-gamecube" };

const match = (name, extra = {}) => ({
  algorithm: "name",
  database: "nintendo-game-boy-advance.pack",
  name,
  platform: "Nintendo - Game Boy Advance",
  variant: "raw",
  ...extra,
});

const FUSION_USA = match("Metroid Fusion (USA)", {
  dumpTags: ["verified dump"],
  expectedComponents: [{ crc32: "d7ae93df", md5: "0".repeat(32), sha1: "1".repeat(40), size: 8388608 }],
  region: "USA",
  revision: "Rev 1",
});
const FUSION_EUROPE = match("Metroid Fusion (Europe)", {
  expectedComponents: [{ crc32: "aabbccdd", size: 8388608 }],
  region: "Europe",
});
// The pack search also returns superstrings of the title; they are not releases.
const FUSION_SEQUEL = match("Metroid Fusion 2 (USA)", { region: "USA" });

const SearchHarness = () => {
  const localizer = useUiLocalizer();
  const lookup = useRomLookup(ROM_LOOKUP_MESSAGES(localizer));
  return createElement(
    "div",
    { className: "rw-app" },
    lookup.result
      ? createElement(RomExpectationCard, {
          expectation: { checks: lookup.result.checks, source: "manual" },
          identification: lookup.result.identification,
        })
      : null,
    createElement(RomSearch, { localizer, lookup }),
  );
};

let root;
let host;

const waitFor = (predicate) => vi.waitUntil(predicate, { interval: 25, timeout: 5000 });

const getInput = () => document.getElementById("rom-weaver-rom-search");
const getForm = () => document.getElementById("rom-weaver-rom-search-form");
const getResults = () =>
  Array.from(document.querySelectorAll(".identify-search-result-btn")).map((button) => button.textContent);
const getError = () => document.querySelector(".identify-search-error");

// React tracks an input's value through the prototype setter, so assigning
// `input.value` directly leaves its onChange unfired and the state stale.
const type = (input, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const submit = (query) => {
  type(getInput(), query);
  getForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};

beforeEach(async () => {
  lookupExpectedRom.mockReset();
  searchExpectedRomByName.mockReset();
  searchExpectedRomTitles.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(createElement(SearchHarness, {}));
  await waitFor(() => getInput() !== null);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

test("one box takes a checksum or a name, with no platform to choose first", async () => {
  expect(getForm().querySelector("label").textContent).toBe("Identify by checksum or game name");
  expect(getInput().placeholder).toBe("Game, system, or checksum");
  expect(getInput().disabled).toBe(false);
  expect(document.querySelector("select")).toBeNull();
});

test("typing searches after a pause without submitting the form", async () => {
  searchExpectedRomTitles.mockResolvedValue({ status: "ok", titles: [FUSION] });
  type(getInput(), "metroid gba");

  await waitFor(() => getResults().length === 1);
  expect(searchExpectedRomTitles).toHaveBeenCalledExactlyOnceWith("metroid gba", expect.anything());
  expect(getResults()[0]).toContain("Metroid Fusion");
  expect(getInput().disabled).toBe(false);
});

test("a name search lists titles across every platform", async () => {
  searchExpectedRomTitles.mockResolvedValue({ status: "ok", titles: [FUSION, ZERO_MISSION, PRIME] });

  submit("metroid");
  await waitFor(() => getResults().length === 3);

  expect(searchExpectedRomTitles).toHaveBeenCalledTimes(1);
  expect(searchExpectedRomTitles.mock.calls[0][0]).toBe("metroid");
  expect(lookupExpectedRom).not.toHaveBeenCalled();
  // The platform is what separates two rows with the same title.
  expect(getResults()[0]).toContain("Metroid Fusion");
  expect(getResults()[0]).toContain("Nintendo - Game Boy Advance");
  expect(getResults()[2]).toContain("Nintendo - GameCube");
  expect(document.querySelector(".identify-search-results-label").textContent).toBe("Choose the game you need");
});

test("a name shorter than two characters never reaches the lookup", async () => {
  submit("m");
  await waitFor(() => getError() !== null);

  expect(getError().textContent).toContain("at least 2 characters");
  expect(searchExpectedRomTitles).not.toHaveBeenCalled();
});

test("choosing a title lists its releases, and choosing one fills the expected-ROM card", async () => {
  searchExpectedRomTitles.mockResolvedValue({ status: "ok", titles: [FUSION, ZERO_MISSION] });
  searchExpectedRomByName.mockResolvedValue({
    matches: [FUSION_SEQUEL, FUSION_USA, FUSION_EUROPE],
    status: "matched",
  });

  submit("metroid");
  await waitFor(() => getResults().length === 2);
  document.querySelectorAll(".identify-search-result-btn")[0].click();
  await waitFor(() => getResults()[0]?.includes("(USA)"));
  expect(getResults()).toHaveLength(2);

  expect(searchExpectedRomByName).toHaveBeenCalledTimes(1);
  expect(searchExpectedRomByName.mock.calls[0][0]).toBe("nintendo-game-boy-advance");
  expect(searchExpectedRomByName.mock.calls[0][1]).toBe("Metroid Fusion");
  expect(document.querySelector(".identify-search-results-label").textContent).toContain("Metroid Fusion");
  expect(document.querySelector(".identify-search-results-label").textContent).toContain("Game Boy Advance");
  // Region, revision, and dump tags are what separate two releases of one game.
  expect(getResults()[0]).toContain("USA");
  expect(getResults()[0]).toContain("Rev 1");
  expect(getResults()[0]).toContain("verified dump");
  expect(getResults()[1]).toContain("Metroid Fusion (Europe)");

  host.style.width = "350px";
  for (const button of document.querySelectorAll(".identify-search-result-btn--version")) {
    const bounds = button.getBoundingClientRect();
    for (const checksum of button.querySelectorAll(".identify-search-result-checksum")) {
      const checkBounds = checksum.getBoundingClientRect();
      expect(checkBounds.top).toBeGreaterThanOrEqual(bounds.top);
      expect(checkBounds.bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(checkBounds.right).toBeLessThanOrEqual(bounds.right);
      expect(checksum.scrollWidth).toBeLessThanOrEqual(checksum.clientWidth + 1);
    }
  }

  // The way back keeps the titles found.
  document.querySelector(".identify-search-back").click();
  await waitFor(() => getResults().length === 2 && getResults()[1]?.includes("Zero Mission"));
  document.querySelectorAll(".identify-search-result-btn")[0].click();
  await waitFor(() => getResults()[0]?.includes("(USA)"));
  document.querySelectorAll(".identify-search-result-btn")[0].click();

  await waitFor(() => document.querySelector("#rom-weaver-bundle-rom-expectation") !== null);
  const card = document.querySelector("#rom-weaver-bundle-rom-expectation");
  expect(card.textContent).toContain("Metroid Fusion (USA)");
  const checks = Array.from(card.querySelectorAll(".ck")).map((row) => row.textContent || "");
  expect(checks.some((row) => row.includes("d7ae93df"))).toBe(true);
  expect(checks.some((row) => row.includes("8388608"))).toBe(true);
  expect(getResults()).toEqual([]);
});

test("a title with one release stays selectable", async () => {
  searchExpectedRomTitles.mockResolvedValue({ status: "ok", titles: [FUSION] });
  searchExpectedRomByName.mockResolvedValue({ matches: [FUSION_USA], status: "matched" });

  submit("fusion");
  await waitFor(() => getResults().length === 1);
  document.querySelector(".identify-search-result-btn").click();

  await waitFor(() => getResults().length === 1 && getResults()[0]?.includes("Metroid Fusion (USA)"));
  expect(getResults()[0]).toContain("d7ae93df");
  expect(document.querySelector("#rom-weaver-bundle-rom-expectation")).toBeNull();
  document.querySelector(".identify-search-result-btn").click();

  await waitFor(() => document.querySelector("#rom-weaver-bundle-rom-expectation") !== null);
  expect(document.querySelector("#rom-weaver-bundle-rom-expectation").textContent).toContain("Metroid Fusion (USA)");
});

test("a checksum lists releases before the user selects one", async () => {
  lookupExpectedRom.mockResolvedValue({ matches: [FUSION_USA], status: "matched" });

  submit("D7AE93DF");
  await waitFor(() => getResults().length === 1 && getResults()[0]?.includes("Metroid Fusion (USA)"));

  expect(lookupExpectedRom).toHaveBeenCalledTimes(1);
  expect(lookupExpectedRom.mock.calls[0][0]).toEqual({ checksums: { crc32: "d7ae93df" } });
  expect(searchExpectedRomTitles).not.toHaveBeenCalled();
  expect(document.querySelector("#rom-weaver-bundle-rom-expectation")).toBeNull();

  document.querySelector(".identify-search-result-btn").click();
  await waitFor(() => document.querySelector("#rom-weaver-bundle-rom-expectation") !== null);
});
