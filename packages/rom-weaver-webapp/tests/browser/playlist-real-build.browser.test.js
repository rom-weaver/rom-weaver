import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildPlaylist } from "../../src/platform/browser/browser-api.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { readRuntimeOutputBytes } from "../../src/storage/vfs/runtime-output.ts";
import { PlaylistForm } from "../../src/webapp/components/playlist-form.tsx";

/* Unlike playlist-workflow.browser.test.js, nothing here is mocked: the form calls the real
   `buildPlaylist`, which stages the files into the real WASM `playlist` command. Staging rewrites
   non-ASCII names, so these cover the playlist keeping the names of the user's own files. */
const DISC_2 = "Pokémon Stadium (Disc 2).iso";
const DISC_1 = "Pokémon Stadium (Disc 1).iso";
const decode = async (output) => new TextDecoder().decode(await readRuntimeOutputBytes(output));
// Staging keeps a recently used file's guest name reserved, so a different file reusing it gets a
// `-2` suffix that a cue sheet cannot match. Each test therefore names its game differently.
let gameCount = 0;
const uniqueGame = () => {
  gameCount += 1;
  return `Game${gameCount}`;
};
const sheet = (bin) => `FILE "${bin}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`;

let root;
let host;
const waitFor = (predicate) => vi.waitUntil(predicate, { interval: 25, timeout: 20000 });
const cardNames = () =>
  [...host.querySelectorAll("ol[aria-label='Discs in playlist order'] .nm")].map((node) => node.textContent);

const mount = async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(createElement(RomWeaverSettingsProvider, null, createElement(PlaylistForm)));
  await waitFor(() => host.querySelector("#playlist-input-picker"));
};
const pick = (files) => {
  const picker = host.querySelector("#playlist-input-picker");
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  picker.files = transfer.files;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
};

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

test("the playlist lists the user's non-ASCII file names in disc order", async () => {
  const files = [new File(["2"], DISC_2), new File(["1"], DISC_1)];
  const built = await buildPlaylist({ archive: false, files, outputName: "Stadium.m3u", sort: true });
  try {
    expect(built.entries).toEqual([DISC_1, DISC_2]);
    expect(built.discIndexes).toEqual([1, 0]);
    expect(built.output.fileName).toBe("Stadium.m3u");
    expect(await decode(built.output)).toBe(`${DISC_1}\n${DISC_2}\n`);
  } finally {
    await built.output.dispose();
  }
});

test("a cue sheet and its track file are not split into two discs", async () => {
  const game = uniqueGame();
  const files = [
    new File([sheet(`${game} (Disc 1).bin`)], `${game} (Disc 1).cue`),
    new File(["b"], `${game} (Disc 1).bin`),
    new File([sheet(`${game} (Disc 2).bin`)], `${game} (Disc 2).cue`),
    new File(["b"], `${game} (Disc 2).bin`),
  ];
  const built = await buildPlaylist({ archive: false, files, outputName: `${game}.m3u`, sort: true });
  try {
    expect(built.entries).toEqual([`${game} (Disc 1).cue`, `${game} (Disc 2).cue`]);
    expect(built.discIndexes).toEqual([0, 2]);
  } finally {
    await built.output.dispose();
  }
});

test("a non-ASCII cue sheet and its track file stay one disc", async () => {
  // Staging rewrites `é` in the file names, but the cue text still names the real track file.
  const game = `Pokémon ${uniqueGame()}`;
  const files = [
    new File([sheet(`${game} (Disc 1).bin`)], `${game} (Disc 1).cue`),
    new File(["b"], `${game} (Disc 1).bin`),
    new File([sheet(`${game} (Disc 2).bin`)], `${game} (Disc 2).cue`),
    new File(["b"], `${game} (Disc 2).bin`),
  ];
  const built = await buildPlaylist({ archive: false, files, outputName: "list.m3u", sort: true });
  try {
    expect(built.entries).toEqual([`${game} (Disc 1).cue`, `${game} (Disc 2).cue`]);
    expect(built.discIndexes).toEqual([0, 2]);
  } finally {
    await built.output.dispose();
  }
});

test("a ZIP of a non-ASCII cue sheet holds its track file", async () => {
  const game = `Pokémon ${uniqueGame()}`;
  const files = [
    new File([sheet(`${game} (Disc 1).bin`)], `${game} (Disc 1).cue`),
    new File(["b"], `${game} (Disc 1).bin`),
    new File([sheet(`${game} (Disc 2).bin`)], `${game} (Disc 2).cue`),
    new File(["b"], `${game} (Disc 2).bin`),
  ];
  const built = await buildPlaylist({ archive: true, files, outputName: "list.zip", sort: true });
  try {
    expect(built.discIndexes).toEqual([0, 2]);
    expect(built.output.size).toBeGreaterThan(0);
  } finally {
    await built.output.dispose();
  }
});

test("the form shows, orders and removes discs whose names staging rewrites", async () => {
  await mount();
  pick([new File(["2"], DISC_2), new File(["1"], DISC_1)]);
  await waitFor(() => cardNames().length === 2);
  expect(cardNames()).toEqual([DISC_1, DISC_2]);
  expect(host.querySelector(".playlist-extras")).toBeNull();

  host.querySelector(`[aria-label='Remove ${DISC_2}']`).click();
  await waitFor(() => cardNames().length === 1);
  expect(cardNames()).toEqual([DISC_1]);
});

test("removing a cue disc takes its track file with it", async () => {
  const game = uniqueGame();
  await mount();
  pick([
    new File([sheet(`${game} (Disc 1).bin`)], `${game} (Disc 1).cue`),
    new File(["b"], `${game} (Disc 1).bin`),
    new File([sheet(`${game} (Disc 2).bin`)], `${game} (Disc 2).cue`),
    new File(["b"], `${game} (Disc 2).bin`),
  ]);
  await waitFor(() => cardNames().length === 2);
  expect(host.querySelector(".playlist-extras").textContent).toContain(`${game} (Disc 2).bin`);

  host.querySelector(`[aria-label='Remove ${game} (Disc 2).cue']`).click();
  await waitFor(() => cardNames().length === 1);
  await waitFor(() => !host.querySelector("[role='status']"));
  expect(cardNames()).toEqual([`${game} (Disc 1).cue`]);
  expect(host.querySelector(".playlist-extras").textContent).not.toContain(`${game} (Disc 2).bin`);
});

test("a different file with the same name is refused instead of dropped", async () => {
  await mount();
  pick([new File(["a"], "track01.bin"), new File(["1"], "Game (Disc 1).chd")]);
  await waitFor(() => cardNames().length === 2);
  pick([new File(["other"], "track01.bin")]);
  await waitFor(() => host.textContent.includes("A different file named track01.bin"));
  expect(cardNames()).toEqual(["Game (Disc 1).chd", "track01.bin"]);
});

test("removing or adding a disc keeps the order the user set with up/down", async () => {
  const game = uniqueGame();
  const names = ["Alpha", "Bravo", "Charlie"].map((name) => `${game} ${name}.chd`);
  await mount();
  pick(names.map((name) => new File([name], name)));
  await waitFor(() => cardNames().length === 3);
  expect(cardNames()).toEqual(names);

  host.querySelector(`[aria-label='Move ${names[2]} up']`).click();
  await waitFor(() => cardNames()[1] === names[2]);
  host.querySelector(`[aria-label='Move ${names[2]} up']`).click();
  await waitFor(() => cardNames()[0] === names[2]);
  expect(cardNames()).toEqual([names[2], names[0], names[1]]);

  host.querySelector(`[aria-label='Remove ${names[1]}']`).click();
  await waitFor(() => cardNames().length === 2);
  await waitFor(() => !host.querySelector("[role='status']"));
  expect(cardNames()).toEqual([names[2], names[0]]);

  const added = `${game} Delta.chd`;
  pick([new File(["d"], added)]);
  await waitFor(() => cardNames().length === 3);
  await waitFor(() => !host.querySelector("[role='status']"));
  expect(cardNames()).toEqual([names[2], names[0], added]);
});
