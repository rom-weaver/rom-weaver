import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "../../src/webapp/design-system/index.css";
// deferred.css ships lazily in production (webapp.ts loads it at boot); the
// drawers the expectation card renders come from it.
import "../../src/webapp/design-system/deferred.css";

/* The identify data seam both search paths share. Stubbing it drives the name
   search's real DOM and real stylesheets without the wasm runtime, the same way
   the checksum path is covered. Mounting the whole apply form here instead would
   make Vitest re-instrument its import graph, which deadlocks the browser
   runner (see expected-rom-card.browser.test.js). */
const { listExpectedRomPlatforms, lookupExpectedRom, searchExpectedRomByName } = vi.hoisted(() => ({
  listExpectedRomPlatforms: vi.fn(),
  lookupExpectedRom: vi.fn(),
  searchExpectedRomByName: vi.fn(),
}));
vi.mock("../../src/lib/apply/expected-rom-lookup.ts", () => ({
  listExpectedRomPlatforms,
  lookupExpectedRom,
  searchExpectedRomByName,
}));

const { ROM_NAME_LOOKUP_MESSAGES, RomExpectationCard, RomNameSearch } =
  await import("../../src/public/react/components/ds/rom-expectation-card.tsx");
const { useRomNameLookup } = await import("../../src/public/react/use-rom-name-lookup.ts");
const { useUiLocalizer } = await import("../../src/public/react/settings-context.tsx");

const PLATFORMS = [
  { platform: "Nintendo - Game Boy Advance", slug: "nintendo-game-boy-advance" },
  { platform: "Nintendo - Nintendo 64", slug: "nintendo-nintendo-64" },
  { platform: "Sega - Mega Drive - Genesis", slug: "sega-mega-drive-genesis" },
];

const match = (name, extra = {}) => ({
  algorithm: "name",
  database: "nintendo-game-boy-advance.pack",
  name,
  platform: "Nintendo - Game Boy Advance",
  variant: "raw",
  ...extra,
});

const METROID = match("Metroid Fusion (USA)", {
  dumpTags: ["verified dump"],
  expectedComponents: [{ crc32: "d7ae93df", md5: "0".repeat(32), sha1: "1".repeat(40), size: 8388608 }],
  region: "USA",
  revision: "Rev 1",
});
const ZERO_MISSION = match("Metroid - Zero Mission (Europe)", {
  expectedComponents: [{ crc32: "aabbccdd", size: 8388608 }],
  region: "Europe",
});

const NameSearchHarness = () => {
  const localizer = useUiLocalizer();
  const lookup = useRomNameLookup(ROM_NAME_LOOKUP_MESSAGES(localizer));
  return createElement(
    "div",
    { className: "rw-app" },
    lookup.result
      ? createElement(RomExpectationCard, {
          expectation: { checks: lookup.result.checks, source: "manual" },
          identification: lookup.result.identification,
        })
      : null,
    createElement(RomNameSearch, { localizer, lookup }),
  );
};

let root;
let host;

const waitFor = (predicate) => vi.waitUntil(predicate, { interval: 25, timeout: 5000 });

const getPlatformInput = () => document.getElementById("rom-weaver-rom-name-platform");
const getPlatformOptions = () =>
  Array.from(document.querySelectorAll(".identify-name-platform-btn")).map((button) => button.textContent);
const getNameInput = () => document.getElementById("rom-weaver-rom-name");
const getForm = () => document.getElementById("rom-weaver-rom-name-search");
const getResults = () =>
  Array.from(document.querySelectorAll(".identify-name-result-btn")).map((button) => button.textContent);

// React tracks an input's value through the prototype setter, so assigning
// `input.value` directly leaves its onChange unfired and the state stale.
const type = (input, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const choosePlatform = async (label) => {
  type(getPlatformInput(), label);
  await waitFor(() => getPlatformOptions().length > 0);
  const option = Array.from(document.querySelectorAll(".identify-name-platform-btn")).find(
    (button) => button.textContent === label,
  );
  option.click();
  await waitFor(() => !getNameInput().disabled);
};

const submit = (query) => {
  type(getNameInput(), query);
  getForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};

beforeEach(() => {
  listExpectedRomPlatforms.mockReset();
  searchExpectedRomByName.mockReset();
  listExpectedRomPlatforms.mockResolvedValue(PLATFORMS);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

// The catalog loads on the first interaction with the picker, not on mount,
// so an apply run that never opens this search costs no fetch.
const mount = async () => {
  root.render(createElement(NameSearchHarness, {}));
  await waitFor(() => getPlatformInput() !== null);
  expect(listExpectedRomPlatforms).not.toHaveBeenCalled();
  getPlatformInput().focus();
  await waitFor(() => getPlatformOptions().length === PLATFORMS.length);
};

test("the platform list says nothing until the catalog answers", async () => {
  root.render(createElement(NameSearchHarness, {}));
  await waitFor(() => getPlatformInput() !== null);

  // The list is empty before the fetch because nothing arrived yet, so it MUST
  // NOT claim the catalog holds no match.
  expect(listExpectedRomPlatforms).not.toHaveBeenCalled();
  expect(getPlatformOptions()).toEqual([]);
  expect(document.querySelector(".identify-name-platform-empty")).toBeNull();

  getPlatformInput().focus();
  await waitFor(() => getPlatformOptions().length === PLATFORMS.length);
  expect(document.querySelector(".identify-name-platform-empty")).toBeNull();
});

test("the platform picker filters as the user types", async () => {
  await mount();

  expect(getPlatformOptions()).toEqual(PLATFORMS.map((entry) => entry.platform));

  type(getPlatformInput(), "mega");
  await waitFor(() => getPlatformOptions().length === 1);
  expect(getPlatformOptions()).toEqual(["Sega - Mega Drive - Genesis"]);

  // Every word has to match, so a two-word filter narrows further.
  type(getPlatformInput(), "nintendo boy");
  await waitFor(() => getPlatformOptions().length === 1);
  expect(getPlatformOptions()).toEqual(["Nintendo - Game Boy Advance"]);

  type(getPlatformInput(), "dreamcast");
  await waitFor(() => document.querySelector(".identify-name-platform-empty") !== null);
  expect(getPlatformOptions()).toEqual([]);
});

test("the query input stays disabled until a platform is chosen", async () => {
  await mount();

  expect(getNameInput().disabled).toBe(true);
  expect(getNameInput().placeholder).toBe("Choose a platform first");

  await choosePlatform("Nintendo - Game Boy Advance");

  expect(getNameInput().disabled).toBe(false);
  expect(getNameInput().placeholder).toBe("Game name");
  // A chosen platform replaces the list with a way back to it.
  expect(getPlatformOptions()).toEqual([]);
  expect(document.querySelector(".identify-name-platform-change")).not.toBeNull();
});

test("a search renders its results and searches only the chosen platform", async () => {
  searchExpectedRomByName.mockResolvedValue({ matches: [METROID, ZERO_MISSION], status: "matched" });
  await mount();
  await choosePlatform("Nintendo - Game Boy Advance");

  submit("metroid");
  await waitFor(() => getResults().length === 2);

  expect(searchExpectedRomByName).toHaveBeenCalledTimes(1);
  expect(searchExpectedRomByName.mock.calls[0][0]).toBe("nintendo-game-boy-advance");
  expect(searchExpectedRomByName.mock.calls[0][1]).toBe("metroid");
  expect(getResults()[0]).toContain("Metroid Fusion (USA)");
  // Region, revision, and dump tags are what separate two rows of one name.
  expect(getResults()[0]).toContain("USA");
  expect(getResults()[0]).toContain("Rev 1");
  expect(getResults()[0]).toContain("verified dump");
  expect(getResults()[1]).toContain("Metroid - Zero Mission (Europe)");
});

test("a query shorter than two characters never reaches the lookup", async () => {
  await mount();
  await choosePlatform("Nintendo - Game Boy Advance");

  submit("m");
  await waitFor(() => document.querySelector(".identify-hash-error") !== null);

  expect(document.querySelector(".identify-hash-error").textContent).toContain("at least 2 characters");
  expect(searchExpectedRomByName).not.toHaveBeenCalled();
});

test("choosing a result fills the expected-ROM card", async () => {
  searchExpectedRomByName.mockResolvedValue({ matches: [METROID, ZERO_MISSION], status: "matched" });
  await mount();
  await choosePlatform("Nintendo - Game Boy Advance");

  submit("metroid");
  await waitFor(() => getResults().length === 2);
  document.querySelectorAll(".identify-name-result-btn")[0].click();

  await waitFor(() => document.querySelector("#rom-weaver-bundle-rom-expectation") !== null);
  const card = document.querySelector("#rom-weaver-bundle-rom-expectation");
  expect(card.textContent).toContain("Metroid Fusion (USA)");
  const checks = Array.from(card.querySelectorAll(".ck")).map((row) => row.textContent || "");
  expect(checks.some((row) => row.includes("d7ae93df"))).toBe(true);
  expect(checks.some((row) => row.includes("8388608"))).toBe(true);
});
