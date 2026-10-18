import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setPlaylistHandoff } from "../../src/lib/playlist-handoff.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";

/* The shared `playlist` command is exercised against real WASM in
   tests/wasm/playlist.test.mjs. This file stands in for it with a small model
   of its ordering and M3U output and drives the page through the real DOM and
   stylesheets: drop out of order, ordered preview, reorder, build, download. */
const { buildPlaylist } = vi.hoisted(() => ({ buildPlaylist: vi.fn() }));
vi.mock("../../src/platform/browser/browser-api.ts", () => ({ buildPlaylist }));

const { PlaylistForm } = await import("../../src/webapp/components/playlist-form.tsx");

const DISC_SHEET = /\.(cue|gdi|chd|iso)$/i;
const discNumber = (name) => Number(/disc\s*(\d+)/i.exec(name)?.[1] ?? 0);

let root;
let host;
let saved;

const fakeBuild = async ({ archive, files, sort }) => {
  const names = files.map((file) => file.name);
  const discs = names.filter((name) => DISC_SHEET.test(name));
  const entries = sort ? [...discs].sort((a, b) => discNumber(a) - discNumber(b)) : discs;
  const body = `${entries.join("\n")}\n`;
  return {
    entries,
    output: {
      dispose: vi.fn(),
      fileName: archive ? "x.zip" : "x.m3u",
      saveAs: vi.fn(async () => {
        saved.push(body);
      }),
      size: body.length,
    },
  };
};

const waitFor = (predicate) => vi.waitUntil(predicate, { interval: 25, timeout: 5000 });
const cardNames = () =>
  [...host.querySelectorAll("ol[aria-label='Discs in playlist order'] .nm")].map((node) => node.textContent);
const button = (pattern) => [...host.querySelectorAll("button")].find((node) => pattern.test(node.textContent));

const mount = async (props = {}) => {
  host = document.createElement("div");
  host.id = "app";
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(createElement(RomWeaverSettingsProvider, null, createElement(PlaylistForm, props)));
  await waitFor(() => host.querySelector("#playlist-input-picker"));
};

const pick = (files) => {
  const picker = host.querySelector("#playlist-input-picker");
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  picker.files = transfer.files;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
};

beforeEach(() => {
  saved = [];
  buildPlaylist.mockReset();
  buildPlaylist.mockImplementation(fakeBuild);
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

test("drops discs out of order, shows them ordered, reorders and downloads the M3U", async () => {
  await mount();
  pick([
    new File(["3"], "Game (Disc 3).cue"),
    new File(["1"], "Game (Disc 1).cue"),
    new File(["b"], "Game (Disc 1).bin"),
    new File(["2"], "Game (Disc 2).cue"),
  ]);
  await waitFor(() => cardNames().length === 3);
  expect(cardNames()).toEqual(["Game (Disc 1).cue", "Game (Disc 2).cue", "Game (Disc 3).cue"]);
  expect(host.querySelector(".playlist-extras").textContent).toContain("Game (Disc 1).bin");

  const up = host.querySelector("[aria-label='Move Game (Disc 3).cue up']");
  up.click();
  await waitFor(() => cardNames()[1] === "Game (Disc 3).cue");
  expect(cardNames()).toEqual(["Game (Disc 1).cue", "Game (Disc 3).cue", "Game (Disc 2).cue"]);
  host.querySelector("[aria-label='Move Game (Disc 1).cue down']").click();
  await waitFor(() => cardNames()[0] === "Game (Disc 3).cue");
  expect(cardNames()).toEqual(["Game (Disc 3).cue", "Game (Disc 1).cue", "Game (Disc 2).cue"]);

  button(/Build playlist/).click();
  await waitFor(() => saved.length === 1);
  expect(saved[0]).toBe("Game (Disc 3).cue\nGame (Disc 1).cue\nGame (Disc 2).cue\n");
  const final = buildPlaylist.mock.calls.at(-1)[0];
  expect(final).toMatchObject({ archive: false, outputName: "Game.m3u", sort: false });
  expect(final.files.map((file) => file.name)).toEqual([
    "Game (Disc 3).cue",
    "Game (Disc 1).cue",
    "Game (Disc 2).cue",
    "Game (Disc 1).bin",
  ]);
});

test("takes the discs Extract hands over", async () => {
  setPlaylistHandoff(
    ["Game (Disc 2).chd", "Game (Disc 1).chd"].map((name) => ({
      name,
      size: 1,
      source: new File(["x"], name),
    })),
  );
  await mount();
  await waitFor(() => cardNames().length === 2);
  expect(cardNames()).toEqual(["Game (Disc 1).chd", "Game (Disc 2).chd"]);
  expect(buildPlaylist.mock.calls[0][0]).toMatchObject({ sort: true });
});
