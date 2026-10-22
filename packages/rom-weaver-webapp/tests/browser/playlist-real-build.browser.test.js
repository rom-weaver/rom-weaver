import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildPlaylist } from "../../src/platform/browser/browser-api.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { readRuntimeOutputBytes } from "../../src/storage/vfs/runtime-output.ts";
import { PlaylistForm } from "../../src/webapp/components/playlist-form.tsx";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";

/* These tests MUST exercise the real browser staging and WASM playlist command so filename
   normalization cannot silently change companion identity or playlist lines. */
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

test("playlist staging rejects ambiguous normalized track names before building a ZIP", async () => {
  await expect(
    buildPlaylist({
      archive: true,
      files: [
        new File([sheet("_Track.bin")], "Disc1.cue"),
        new File(["A"], "_Track.bin"),
        new File([sheet("Track.bin")], "Disc2.cue"),
        new File(["B"], "Track.bin"),
      ],
      outputName: "collision.zip",
      sort: true,
    }),
  ).rejects.toThrow(/_Track\.bin.*Track\.bin.*Rename one file.*CUE\/GDI/);
});

test("a missing companion cannot alias another supplied track's staging name", async () => {
  for (const [missing, supplied] of [
    ["_Track.bin", "Track.bin"],
    ["Track.bin", "_Track.bin"],
    ["Track.bin", " Track.bin"],
    ["Track.bin", "Track.bin "],
  ]) {
    await expect(
      buildPlaylist({
        archive: true,
        files: [
          new File([sheet(missing)], "Disc1.cue"),
          new File([sheet(supplied)], "Disc2.cue"),
          new File(["B"], supplied),
        ],
        outputName: "missing.zip",
        sort: true,
      }),
    ).rejects.toThrow(/missing/);
  }
});

test("a ZIP resolves original underscore and Unicode companion names to their exact bytes", async () => {
  const tracks = [
    ["_Track.bin", "underscore"],
    ["Pokémon.bin", "accent"],
    ["日本語.bin", "japanese"],
  ];
  const files = tracks.flatMap(([name, bytes], index) => [
    new File([sheet(name)], `Disc${index + 1}.cue`),
    new File([bytes], name),
  ]);
  const built = await buildPlaylist({ archive: true, files, outputName: "originals.zip", sort: true });
  try {
    expect(built.discIndexes).toEqual(tracks.map((_, index) => index * 2));
    const extracted = await browserRuntime.compression.extract({
      source: new File([await readRuntimeOutputBytes(built.output)], "originals.zip"),
      entries: [],
      extractAll: true,
      format: "zip",
    });
    try {
      expect(extracted.outputs.map((output) => output.fileName).sort()).toEqual(
        ["originals.m3u", ...tracks.map((_, index) => `Disc${index + 1}.cue`), ...tracks.map(([name]) => name)].sort(),
      );
      for (const [name, bytes] of tracks) {
        const output = extracted.outputs.find((output) => output.fileName === name);
        expect(output).toBeDefined();
        expect(await (await browserRuntime.publicOutput.getBlob(output)).text()).toBe(bytes);
      }
    } finally {
      await Promise.all(extracted.outputs.map((output) => output.dispose()));
    }
  } finally {
    await built.output.dispose();
  }
});

test("leading and trailing whitespace companions stay with their disc in a ZIP", async () => {
  for (const name of [" Leading.bin", "Trailing.bin "]) {
    const built = await buildPlaylist({
      archive: true,
      files: [new File([sheet(name)], "Space.cue"), new File(["track"], name)],
      outputName: "spaces.zip",
      sort: true,
    });
    try {
      expect(built.discIndexes).toEqual([0]);
      expect(built.output.size).toBeGreaterThan(0);
    } finally {
      await built.output.dispose();
    }
  }
});

test("removing one cue keeps an audio track shared by the remaining cue", async () => {
  const game = uniqueGame();
  const sharedName = `${game} Shared.wav`;
  await mount();
  pick([
    new File([sheet(sharedName)], `${game} Disc1.cue`),
    new File([sheet(sharedName)], `${game} Disc2.cue`),
    new File(["audio"], sharedName),
  ]);
  await waitFor(() => cardNames().length === 2);
  expect(host.querySelector(".playlist-extras").textContent).toContain(sharedName);
  host.querySelector(`[aria-label='Remove ${game} Disc1.cue']`).click();
  await waitFor(() => cardNames().length === 1);
  await waitFor(() => !host.querySelector("[role='status']"));
  expect(cardNames()).toEqual([`${game} Disc2.cue`]);
  expect(host.querySelector(".playlist-extras").textContent).toContain(sharedName);
});

test("the form shows an actionable error for normalized name collisions", async () => {
  await mount();
  pick([new File(["a"], "_Track.bin"), new File(["b"], "Track.bin")]);
  await waitFor(() => host.textContent.includes("Rename one file"));
  expect(host.textContent).toContain('same browser staging name "Track.bin"');
  await waitFor(() => cardNames().length === 2);
  expect(cardNames()).toEqual(["_Track.bin", "Track.bin"]);
});

test("fresh cue inputs can reuse the previous playlist's names immediately", async () => {
  const game = uniqueGame();
  const cueName = `${game}.cue`;
  const trackName = `${game}.bin`;
  for (const contents of ["A", "B"]) {
    const result = await buildPlaylist({
      archive: false,
      files: [new File([sheet(trackName)], cueName), new File([contents], trackName)],
      outputName: "repeated.m3u",
      sort: true,
    });
    try {
      expect(result.entries).toEqual([cueName]);
      expect(result.discIndexes).toEqual([0]);
    } finally {
      await result.output.dispose();
    }
  }
});
