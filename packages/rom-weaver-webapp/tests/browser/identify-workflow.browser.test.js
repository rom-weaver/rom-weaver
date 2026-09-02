import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import "../../src/webapp/design-system/index.css";
// deferred.css ships lazily in production (webapp.ts loads it at boot); the drawer
// surfaces the identify results live in come from it.
import "../../src/webapp/design-system/deferred.css";

/* The wasm ingest is exercised end to end in tests/wasm/rom-identify.test.mjs
   against synthetic packs. This file drives the four RESULT STATES through the
   real DOM and the real stylesheets, which is where the reporting bugs were. */
const { identifyHash, identifyRom } = vi.hoisted(() => ({ identifyHash: vi.fn(), identifyRom: vi.fn() }));
vi.mock("../../src/platform/browser/browser-api.ts", () => ({ identifyHash, identifyRom }));
// The checksum search is the shared expected-ROM lookup, not a file identify
// run, so it answers through the identify-data seam both pages use.
const { lookupExpectedRom } = vi.hoisted(() => ({ lookupExpectedRom: vi.fn() }));
vi.mock("../../src/lib/apply/expected-rom-lookup.ts", () => ({ lookupExpectedRom }));

const { IdentifyForm } = await import("../../src/webapp/components/identify-form.tsx");

const LONG_TITLE =
  "Legend of the Extremely Long Cartridge Dump Name Which Keeps Going (USA, Europe, Australia) (Rev 2) (Virtual Console)";

const gbaMatch = (name) => ({
  algorithm: "crc32",
  database: "nintendo-game-boy-advance.pack",
  name,
  platform: "Nintendo - Game Boy Advance",
  provenance: [{ source: "opengood", sourceName: "SnowflakePowered/opengood" }],
  variant: "raw",
});

const candidate = (path, status, matches = []) => ({
  checksums: { crc32: "abcd1234", md5: "0".repeat(32), sha1: "1".repeat(40) },
  checksumVariants: [],
  matches,
  path,
  status,
});

let root;
let host;

const settle = () => new Promise((resolve) => globalThis.setTimeout(resolve, 40));
const waitFor = (predicate) => vi.waitUntil(predicate, { interval: 25, timeout: 5000 });
const waitForText = async (text) => {
  try {
    await waitFor(() => host.textContent.includes(text));
  } catch (error) {
    throw new Error(`waiting for "${text}" timed out; DOM read: ${host.textContent}`, { cause: error });
  }
};
const buttonMatching = (pattern) =>
  [...host.querySelectorAll("button")].find((button) => pattern.test(button.textContent));

const mountIdentifyForm = async () => {
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(IdentifyForm, {}));
  await waitFor(() => host.querySelector("#identify-input-picker"));
};

const selectRom = async (fileName = "game.gba") => {
  // The expectation step mounts its own compact picker in place of the hero.
  const input = host.querySelector("#identify-input-picker, #identify-container-expected-picker");
  const transfer = new DataTransfer();
  transfer.items.add(new File([new Uint8Array([1, 2, 3, 4])], fileName));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForText(fileName);
};

// Staging a ROM starts identification on its own; this only waits it out.
const runIdentify = async () => {
  await settle();
};

const openDrawers = async () => {
  for (const button of host.querySelectorAll("button")) {
    if (/Identify|Checksums/.test(button.textContent) && button.getAttribute("aria-expanded") === "false") {
      button.click();
    }
  }
  await settle();
};

beforeEach(async () => {
  await page.viewport(1280, 900);
  document.body.innerHTML = "";
  identifyHash.mockReset();
  identifyRom.mockReset();
  lookupExpectedRom.mockReset();
});

afterEach(() => {
  root?.unmount();
  host?.remove();
});

test("a matched ROM shows its title, its evidence, and a colour-free identified marker", async () => {
  identifyRom.mockResolvedValue({
    candidates: [candidate("game.gba", "matched", [gbaMatch("Metroid Fusion (USA)")])],
    input: "game.gba",
    status: "matched",
  });
  await mountIdentifyForm();
  await selectRom();
  await runIdentify();
  await waitForText("Metroid Fusion (USA)");

  // The state reads without colour: a glyph plus a word, both in the DOM.
  expect(host.querySelector(".identify-state").textContent).toContain("Identified");
  expect(host.querySelector(".identify-state").textContent).toContain("✓");
  expect(host.querySelector(".card.ok")).not.toBeNull();

  await openDrawers();
  const evidence = host.querySelector(".identify-drawer-evidence").textContent;
  expect(evidence).toContain("GBA");
  expect(evidence).toContain("CRC32");
  expect(evidence).toContain("raw");
  // The record's own provenance names the source; the pack file name is not a
  // source and never reaches the drawer.
  expect(evidence).toContain("OpenGood");
  expect(evidence).not.toContain(".pack");
  expect(evidence).not.toContain("SnowflakePowered");
  expect(host.textContent).toContain("abcd1234");
});

test("an unknown ROM reports no checksum match, never that identification failed", async () => {
  identifyRom.mockResolvedValue({
    candidates: [candidate("homebrew.gba", "unknown")],
    input: "homebrew.gba",
    status: "unknown",
  });
  await mountIdentifyForm();
  await selectRom("homebrew.gba");
  await runIdentify();
  await waitForText("No matching checksum found in the identification data.");

  expect(host.textContent).toContain("may be modified, an unlisted revision");
  expect(host.textContent).not.toContain("Identification data could not be loaded");
  expect(host.textContent).not.toContain("Identification unavailable");
  // The verdict reads as an error notice above the ROM card.
  expect(host.querySelector(".notice.error")).not.toBeNull();
  expect(host.querySelector(".identify-state").textContent).toContain("No checksum match");
  // Checksums open on their own: they are all a no-match result can still offer.
  expect(host.textContent).toContain("abcd1234");
});

test("an ambiguous ROM names the count and lists every candidate", async () => {
  identifyRom.mockResolvedValue({
    candidates: [candidate("twin.gba", "ambiguous", [gbaMatch("Twin Game (USA)"), gbaMatch("Twin Game (Europe)")])],
    input: "twin.gba",
    status: "ambiguous",
  });
  await mountIdentifyForm();
  await selectRom("twin.gba");
  await runIdentify();
  await waitForText("2 possible matches");

  expect(host.textContent).toContain("Twin Game (USA)");
  expect(host.textContent).toContain("Twin Game (Europe)");
  expect(host.querySelector(".identify-state").textContent).toContain("Possible match");
  expect(host.textContent).not.toContain("ROM identified");
  expect(host.querySelector(".card.warn")).not.toBeNull();
});

test("an unloadable database reports unavailable, and the retry succeeds", async () => {
  identifyRom
    .mockResolvedValueOnce({
      candidates: [candidate("game.gba", "unavailable")],
      input: "game.gba",
      status: "unavailable",
      unavailableReason: "ROM identify index request failed with HTTP 503",
    })
    .mockResolvedValueOnce({
      candidates: [candidate("game.gba", "matched", [gbaMatch("Metroid Fusion (USA)")])],
      input: "game.gba",
      status: "matched",
    });
  await mountIdentifyForm();
  await selectRom();
  await runIdentify();
  await waitForText("Identification data could not be loaded.");

  expect(host.textContent).toContain("Your ROM was not classified.");
  // It must not read as a verdict about the ROM.
  expect(host.textContent).not.toContain("No exact title match found");
  expect(host.textContent).not.toContain("No title in the local database matched");

  buttonMatching(/Retry identification/).click();
  await waitForText("Metroid Fusion (USA)");
  expect(host.textContent).not.toContain("Identification data could not be loaded");
});

test("a multi-ROM archive reports every member instead of one arbitrary winner", async () => {
  identifyRom.mockResolvedValue({
    archiveName: "collection.zip",
    candidates: [
      candidate("Games/GBA/Metroid Fusion (USA).gba", "matched", [gbaMatch("Metroid Fusion (USA)")]),
      candidate("Games/GBA/Twin Game.gba", "ambiguous", [gbaMatch("Twin Game (USA)"), gbaMatch("Twin Game (Europe)")]),
      candidate("Games/GBA/homebrew.gba", "unknown"),
    ],
    input: "collection.zip",
    status: "ambiguous",
  });
  await mountIdentifyForm();
  await selectRom("collection.zip");
  await runIdentify();
  await waitForText("Games/GBA/Metroid Fusion (USA).gba");

  // Every member is identified on the staged ROM card; the archive itself is
  // not listed as its own row.
  expect(host.textContent).not.toContain("Archive:");
  expect(host.textContent).toContain("Games/GBA/homebrew.gba");
  expect(host.querySelectorAll(".identify-member")).toHaveLength(3);
});

test("a late result from a replaced file cannot repopulate the form", async () => {
  let resolveFirst;
  identifyRom.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  await mountIdentifyForm();
  await selectRom("first.gba");
  await runIdentify();
  await waitForText("Identifying first.gba");

  // Replace the file mid-run, then let the stale operation finish.
  await selectRom("second.gba");
  resolveFirst({
    candidates: [candidate("first.gba", "matched", [gbaMatch("Stale Game (USA)")])],
    input: "first.gba",
    status: "matched",
  });
  await settle();
  await settle();

  expect(host.textContent).not.toContain("Stale Game (USA)");
  expect(host.textContent).toContain("second.gba");
});

for (const [width, height] of [
  [390, 844],
  [320, 640],
]) {
  test(`result states stay readable and never scroll sideways at ${width}x${height}`, async () => {
    identifyRom.mockResolvedValue({
      archiveName: "collection.zip",
      candidates: [
        candidate("Games/GBA/Some Very Deeply Nested Folder Name/Long.gba", "matched", [gbaMatch(LONG_TITLE)]),
      ],
      input: "collection.zip",
      status: "matched",
    });
    await page.viewport(width, height);
    await mountIdentifyForm();
    await selectRom("collection.zip");
    await runIdentify();
    await waitForText(LONG_TITLE);
    await openDrawers();

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    // The deep member path stays inside the card too.
    for (const value of host.querySelectorAll(".identify-member")) {
      expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth + 1);
    }
  });
}

const setHashInput = (value) => {
  const input = host.querySelector(".identify-hash-input");
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

test("an empty form shows the ghost steps next to the checksum search", async () => {
  await mountIdentifyForm();
  expect(host.querySelector(".ghost-steps")).not.toBeNull();
  expect(host.querySelector(".identify-hash-input")).not.toBeNull();
  expect(host.textContent).toContain("Identify by checksum");
});

test("a pasted checksum raises the expected-ROM card without a file", async () => {
  lookupExpectedRom.mockResolvedValue({ matches: [gbaMatch("Metroid Fusion (USA)")], status: "matched" });
  await mountIdentifyForm();
  setHashInput("3610A686");
  buttonMatching(/Search by checksum/).click();
  await waitForText("Metroid Fusion (USA)");

  expect(lookupExpectedRom).toHaveBeenCalledWith({ checksums: { crc32: "3610a686" } }, expect.anything());
  const card = host.querySelector("#identify-container-expected-rom");
  expect(card).not.toBeNull();
  expect(card.textContent).toContain("Found by checksum - add the ROM to verify it");
  // The database fills the card out under ONE Expected head that names it.
  expect(card.querySelector(".ck-head-note").textContent).toContain("your checksum");
  // The step opens for the optional ROM, so the ghost steps step aside.
  expect(host.querySelector(".ghost-steps")).toBeNull();
  expect(host.textContent).toContain("Add the ROM to verify it");
});

test("an invalid checksum shows the inline error and never runs", async () => {
  await mountIdentifyForm();
  setHashInput("not-a-hash");
  buttonMatching(/Search by checksum/).click();
  await waitForText("hex characters");

  expect(lookupExpectedRom).not.toHaveBeenCalled();
  expect(host.querySelector(".identify-hash-error")).not.toBeNull();
  // The ghost steps stay: nothing ran, so nothing is staged.
  expect(host.querySelector(".ghost-steps")).not.toBeNull();
});

test("a wrong-length checksum names the accepted lengths", async () => {
  await mountIdentifyForm();
  setHashInput("abc123");
  buttonMatching(/Search by checksum/).click();
  await waitForText("40 (SHA-1)");

  expect(lookupExpectedRom).not.toHaveBeenCalled();
  expect(host.querySelector(".identify-hash-error")).not.toBeNull();
});

test("staging a file keeps the expectation and verifies the ROM against it", async () => {
  lookupExpectedRom.mockResolvedValue({ matches: [gbaMatch("Metroid Fusion (USA)")], status: "matched" });
  identifyRom.mockResolvedValue({
    candidates: [candidate("other.gba", "matched", [gbaMatch("Metroid Fusion (USA)")])],
    input: "other.gba",
    status: "matched",
  });
  await mountIdentifyForm();
  // The staged candidate carries crc32 abcd1234, so this is the matching paste.
  setHashInput("abcd1234");
  buttonMatching(/Search by checksum/).click();
  await waitForText("Metroid Fusion (USA)");

  await selectRom("other.gba");
  await runIdentify();
  await openDrawers();
  // The expectation survives the drop and lands as Expected rows on the card.
  const hashInput = host.querySelector(".identify-hash-input");
  expect(hashInput.value).toBe("abcd1234");
  await waitFor(() => host.querySelector("#rom-weaver-rom-expected-checks"));
  expect(host.querySelector(".card.ok")).not.toBeNull();
});

test("a staged ROM that misses the pasted checksum faults the step", async () => {
  lookupExpectedRom.mockResolvedValue({ matches: [gbaMatch("Metroid Fusion (USA)")], status: "matched" });
  identifyRom.mockResolvedValue({
    candidates: [candidate("other.gba", "matched", [gbaMatch("Metroid Fusion (USA)")])],
    input: "other.gba",
    status: "matched",
  });
  await mountIdentifyForm();
  setHashInput("deadbeef");
  buttonMatching(/Search by checksum/).click();
  await waitForText("Metroid Fusion (USA)");

  await selectRom("other.gba");
  await runIdentify();
  await waitFor(() => host.querySelector(".card.bad"));
  expect(host.querySelector(".card.bad")).not.toBeNull();
});
