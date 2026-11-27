import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { invokeRomWeaverCompressionCreateWorker } from "../../src/lib/runtime/wasm-compression-commands.ts";
import { planBrowserPlaylist, writeBrowserPlaylistZip } from "../../src/platform/browser/browser-playlist-api.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { registerBrowserVirtualFile } from "../../src/workers/protocol/browser-virtual-files.ts";
import { PlaylistForm } from "../../src/webapp/components/playlist-form.tsx";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

const SECTOR = 2352;
const sheet = (track) => `FILE "${track}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`;
const track = (seed) => new Uint8Array(SECTOR).fill(seed);
const at = (path, parts) => ({ file: new File(parts, path.slice(path.lastIndexOf("/") + 1)), path });
const lines = (text) => text.split(/\r?\n/).filter(Boolean);

// Two PlayStation discs, the first with its LibCrypt `.sbi`.
const ff7Files = () => ({
  "ff7.disc01.bin": track(1),
  "ff7.disc01.cue": sheet("ff7.disc01.bin"),
  "ff7.disc01.sbi": "libcrypt",
  "ff7.disc02.bin": track(2),
  "ff7.disc02.cue": sheet("ff7.disc02.bin"),
  "notes.txt": "keep",
});

let mounted = null;
let folderName = null;
const realPicker = Object.getOwnPropertyDescriptor(window, "showDirectoryPicker");

afterEach(async () => {
  mounted?.unmount();
  mounted = null;
  document.getElementById("app")?.remove();
  if (realPicker) Object.defineProperty(window, "showDirectoryPicker", realPicker);
  else delete window.showDirectoryPicker;
  if (folderName) {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(folderName, { recursive: true }).catch(() => undefined);
    folderName = null;
  }
});

describe("planBrowserPlaylist", () => {
  test("lists the discs in order and leaves out tracks and operating system files", async () => {
    const plan = await planBrowserPlaylist({
      files: [
        at("Game (Disc 2).cue", [sheet("Game (Disc 2).bin")]),
        at("Game (Disc 2).bin", [track(2)]),
        at("Game (Disc 1).cue", [sheet("Game (Disc 1).bin")]),
        at("Game (Disc 1).bin", [track(1)]),
        at(".DS_Store", ["finder"]),
        at("._Game (Disc 1).cue", ["resource fork"]),
      ],
    });
    expect(plan.file_name).toBe("Game.m3u");
    expect(plan.entries).toEqual(["Game (Disc 1).cue", "Game (Disc 2).cue"]);
    expect(lines(plan.text)).toEqual(["Game (Disc 1).cue", "Game (Disc 2).cue"]);
    expect(plan.discs.map((disc) => disc.path)).toEqual(["Game (Disc 1).cue", "Game (Disc 2).cue"]);
  });

  test("lists discs in subfolders by their path from the picked folder", async () => {
    const plan = await planBrowserPlaylist({
      files: [at("Disc 2/Game (Disc 2).iso", [track(2)]), at("Disc 1/Game (Disc 1).iso", [track(1)])],
    });
    expect(plan.file_name).toBe("Game.m3u");
    expect(lines(plan.text)).toEqual(["Disc 1/Game (Disc 1).iso", "Disc 2/Game (Disc 2).iso"]);
  });

  test("plans renaming in place with rewritten sheets and the same-named .sbi", async () => {
    const plan = await planBrowserPlaylist({
      files: Object.entries(ff7Files()).map(([path, content]) => at(path, [content])),
      name: "Final Fantasy VII",
      renameInPlace: true,
    });
    expect(plan.file_name).toBe("Final Fantasy VII.m3u");
    expect(lines(plan.text)).toEqual(["Final Fantasy VII (Disc 1).cue", "Final Fantasy VII (Disc 2).cue"]);
    const renames = Object.fromEntries(plan.renames.map((rename) => [rename.from, rename]));
    expect(Object.keys(renames).sort()).toEqual([
      "ff7.disc01.bin",
      "ff7.disc01.cue",
      "ff7.disc01.sbi",
      "ff7.disc02.bin",
      "ff7.disc02.cue",
    ]);
    expect(renames["ff7.disc01.sbi"].to).toBe("Final Fantasy VII (Disc 1).sbi");
    expect(renames["ff7.disc02.cue"].to).toBe("Final Fantasy VII (Disc 2).cue");
    expect(renames["ff7.disc02.cue"].text).toContain('FILE "Final Fantasy VII (Disc 2).bin" BINARY');
    expect(renames["ff7.disc02.bin"].text ?? null).toBeNull();
  });

  test("plans a playlist for a folder that already holds one with the same name", async () => {
    const plan = await planBrowserPlaylist({
      files: [
        at("Game (Disc 1).iso", [track(1)]),
        at("Game (Disc 2).iso", [track(2)]),
        at("Game.m3u", ["Game (Disc 1).iso\n"]),
      ],
      name: "Game",
    });
    expect(plan.file_name).toBe("Game.m3u");
    expect(lines(plan.text)).toEqual(["Game (Disc 1).iso", "Game (Disc 2).iso"]);
  });

  test("names the picked folder's paths in an engine error, not the mounted copies", async () => {
    const failure = planBrowserPlaylist({
      files: [at("Disc 1/Game (Disc 1).iso", [track(1)]), at("Disc 2/Game (Disc 2).iso", [track(2)])],
      renameInPlace: true,
    });
    await expect(failure).rejects.toThrow("`Disc 2/Game (Disc 2).iso` is in another");
    await expect(failure).rejects.not.toThrow(WORKER_OPFS_MOUNTPOINT);
  });

  test("asks for a game name when the discs are named only by number, and plans with one", async () => {
    const files = [
      at("Disc 1.cue", [sheet("Disc 1.bin")]),
      at("Disc 1.bin", [track(1)]),
      at("Disc 2.cue", [sheet("Disc 2.bin")]),
      at("Disc 2.bin", [track(2)]),
    ];
    const failure = planBrowserPlaylist({ files });
    await expect(failure).rejects.toThrow("Type a game name");
    await expect(failure).rejects.not.toThrow("--name");
    const plan = await planBrowserPlaylist({ files, name: "FF7" });
    expect(plan.file_name).toBe("FF7.m3u");
    expect(lines(plan.text)).toEqual(["Disc 1.cue", "Disc 2.cue"]);
  });

  test("words an .mds refusal without the command-line flag", async () => {
    const failure = planBrowserPlaylist({
      files: [at("Game (Disc 1).mds", ["mds"]), at("Game (Disc 1).mdf", [track(1)])],
      name: "Game",
      renameInPlace: true,
    });
    await expect(failure).rejects.toThrow("Cannot rename `Game (Disc 1).mds`");
    await expect(failure).rejects.not.toThrow("--rename");
  });

  test("refuses two dropped files with the same name", async () => {
    await expect(
      planBrowserPlaylist({ files: [at("Game.iso", [track(1)]), at("Game.iso", [track(2)])] }),
    ).rejects.toThrow('Two files are named "Game.iso"');
  });
});

const ff7Request = (zip) => ({
  files: Object.entries(ff7Files()).map(([path, content]) => at(path, [content])),
  name: "Final Fantasy VII",
  zip,
});

const readOutput = async (output) => {
  const bytes = new Uint8Array(output.size);
  await output.vfs.read(output.path, bytes);
  return bytes;
};

describe("planBrowserPlaylist ZIP", () => {
  test("plans a ZIP for a folder that already holds one with the same name", async () => {
    const request = ff7Request({ layout: "flat", rename: true });
    const plan = await planBrowserPlaylist({
      ...request,
      files: [...request.files, at("Final Fantasy VII.zip", ["an earlier download"])],
    });
    expect(plan.bundle[0]).toEqual({ path: "Final Fantasy VII.m3u" });
    expect(plan.bundle.some((file) => file.path.endsWith(".zip"))).toBe(false);
  });

  test("lists each file of a renamed ZIP with its source from the picked folder", async () => {
    const plan = await planBrowserPlaylist(ff7Request({ layout: "flat", rename: true }));
    expect(plan.bundle[0]).toEqual({ path: "Final Fantasy VII.m3u" });
    const sheet = plan.bundle.find((file) => file.path === "Final Fantasy VII (Disc 2).cue");
    expect(sheet?.source).toBe("ff7.disc02.cue");
    expect(sheet?.text).toContain('FILE "Final Fantasy VII (Disc 2).bin" BINARY');
    const bin = plan.bundle.find((file) => file.path === "Final Fantasy VII (Disc 2).bin");
    expect(bin?.source).toBe("ff7.disc02.bin");
    expect(plan.bundle.some((file) => file.path === "notes.txt")).toBe(false);
  });

  test("puts a layout's folder in the paths without renaming the discs", async () => {
    const plan = await planBrowserPlaylist(ff7Request({ layout: "m3u-folder", rename: false }));
    expect(plan.bundle.map((file) => file.path)).toContain("Final Fantasy VII.m3u/ff7.disc01.cue");
    expect(plan.bundle[0]?.path).toBe("Final Fantasy VII.m3u/Final Fantasy VII.m3u");
  });

  test("asks for a game name before planning a ZIP", async () => {
    const { name: _name, ...request } = ff7Request({ layout: "flat", rename: false });
    await expect(planBrowserPlaylist(request)).rejects.toThrow("A ZIP needs a game name.");
  });
});

describe("writeBrowserPlaylistZip", () => {
  test("writes a stored ZIP of the renamed discs and their rewritten sheets", async () => {
    const output = await writeBrowserPlaylistZip(ff7Request({ layout: "flat", rename: true }));
    try {
      const bytes = await readOutput(output);
      expect(output.fileName).toBe("Final Fantasy VII.zip");
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("PK\u0003\u0004");
      // The first local file header's method is 0 for a stored entry.
      expect(bytes[8] | (bytes[9] << 8)).toBe(0);
      const text = new TextDecoder("latin1").decode(bytes);
      expect(text).toContain("Final Fantasy VII (Disc 1).cue\nFinal Fantasy VII (Disc 2).cue\n");
      expect(text).toContain('FILE "Final Fantasy VII (Disc 2).bin" BINARY');
      expect(text).not.toContain("ff7.disc01");
      // A ZIP holds the playlist, the discs, and the track files their sheets name. Other files beside them stay out.
      expect(text).not.toContain(".sbi");
      expect(text).not.toContain("notes.txt");
    } finally {
      await output.dispose();
    }
  });

  test("compresses each disc to the CHD that Compress writes for it", async () => {
    const discs = [1, 2].map((number) => {
      const name = `Game (Disc ${number})`;
      return {
        bin: new File([cdTrack(number)], `${name}.bin`),
        cue: new File([`FILE "${name}.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`], `${name}.cue`),
      };
    });
    const output = await writeBrowserPlaylistZip({
      files: discs.flatMap(({ bin, cue }) => [at(cue.name, [cue]), at(bin.name, [bin])]),
      name: "Game",
      zip: { chd: true, layout: "flat", rename: false },
    });
    try {
      const entries = storedZipEntries(await readOutput(output));
      expect([...entries.keys()]).toEqual(["Game.m3u", "Game (Disc 1).chd", "Game (Disc 2).chd"]);
      expect(new TextDecoder().decode(entries.get("Game.m3u"))).toBe("Game (Disc 1).chd\nGame (Disc 2).chd\n");
      for (const [index, disc] of discs.entries()) {
        expect(entries.get(`Game (Disc ${index + 1}).chd`)).toEqual(await compressLikeCompressPage(disc));
      }
    } finally {
      await output.dispose();
    }
  });

  test("rejects a cancelled write, and the next write still works", async () => {
    const request = ff7Request({ layout: "flat", rename: true });
    await expect(writeBrowserPlaylistZip({ ...request, signal: AbortSignal.abort() })).rejects.toThrow();
    const output = await writeBrowserPlaylistZip(request);
    await output.dispose();
  });
});

/** Eight CD sectors of pseudo-random words, which compress to different bytes at each level. */
const cdTrack = (seed) => {
  const words = ["disc ", "track ", "sector ", "weave ", "rom ", "patch ", "game ", "data "];
  let state = seed;
  let text = "";
  while (text.length < 8 * SECTOR) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) & 0x7fff_ffff;
    text += words[state % words.length];
  }
  return new TextEncoder().encode(text.slice(0, 8 * SECTOR));
};

/** The entries of a ZIP whose files are stored, by name, in central directory order. */
const storedZipEntries = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const entries = new Map();
  let at = view.getUint32(end + 16, true);
  for (let index = 0; index < view.getUint16(end + 10, true); index += 1) {
    expect(view.getUint16(at + 10, true)).toBe(0);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.set(name, bytes.slice(data, data + size));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
};

/** The CHD the Compress page writes for a CUE/BIN disc with its default CD codecs and level. */
const compressLikeCompressPage = async ({ bin, cue }) => {
  const root = `${WORKER_OPFS_MOUNTPOINT}/compress-${crypto.randomUUID()}`;
  const paths = [cue, bin].map((file) => `${root}/${file.name}`);
  const release = [cue, bin].map((file, index) => registerBrowserVirtualFile({ path: paths[index], source: file }));
  try {
    const result = await invokeRomWeaverCompressionCreateWorker({
      codecs: ["cdlz", "cdzl", "cdfl"],
      format: "chd",
      inputPaths: [paths[0]],
      knownInputPaths: paths,
      levelProfile: "max",
      outputFileName: cue.name.replace(/\.cue$/, ".chd"),
    });
    try {
      const bytes = new Uint8Array(result.size);
      await browserVfs.read(result.filePath, bytes);
      return bytes;
    } finally {
      await result.cleanup();
    }
  } finally {
    for (const done of release) done();
  }
};

const mountForm = () => {
  const element = document.createElement("div");
  element.id = "app";
  document.body.appendChild(element);
  mounted = createRoot(element);
  mounted.render(createElement(PlaylistForm, { onSessionChange: () => undefined }));
};

const enabledButton = async (selector) => {
  await expect.poll(() => document.querySelector(selector)?.disabled).toBe(false);
  return document.querySelector(selector);
};

const buttonNamed = (label) =>
  [...document.querySelectorAll("#playlist-container button")].find((button) => button.textContent.trim() === label);

const typeInto = (input, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const seedFolder = async (folder, files) => {
  for (const [name, content] of Object.entries(files)) {
    const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
    await writable.write(content);
    await writable.close();
  }
};

// Chrome and Edge offer both; Safari moves files only inside its private storage and has no picker.
const browserCanWriteFolders = () =>
  typeof window.showDirectoryPicker === "function" && typeof FileSystemFileHandle.prototype.move === "function";

const listFolder = async (directory) => {
  const files = {};
  for await (const entry of directory.values()) files[entry.name] = await (await entry.getFile()).text();
  return files;
};

test("renames the discs in the picked folder where the browser can move files, and downloads the renamed discs as a ZIP elsewhere", async () => {
  const canWriteFolders = browserCanWriteFolders();
  const root = await navigator.storage.getDirectory();
  folderName = `playlist-folder-${crypto.randomUUID()}`;
  const folder = await root.getDirectoryHandle(folderName, { create: true });
  const seed = ff7Files();
  await seedFolder(folder, seed);
  if (!canWriteFolders) {
    mountForm();
    const transfer = new DataTransfer();
    for (const [name, content] of Object.entries(seed)) transfer.items.add(new File([content], name));
    await expect.poll(() => document.querySelector("#playlist-input-picker")).toBeTruthy();
    const picker = document.querySelector("#playlist-input-picker");
    picker.files = transfer.files;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await enabledButton("#playlist-download-zip");
    expect(document.querySelector("#playlist-download")).toBeNull();
    const plain = await commands.clickAndReadDownload("#playlist-download-zip");
    expect(plain.suggestedFilename).toBe("ff7.zip");
    expect(atob(plain.contentBase64)).toContain("ff7.disc01.cue\nff7.disc02.cue\n");
    expect(document.querySelector("#playlist-save-folder").disabled).toBe(true);
    const rename = document.querySelector("#playlist-rename-discs");
    // The form is still freeing the first ZIP when its download arrives.
    await expect.poll(() => rename.disabled).toBe(false);
    rename.click();
    await expect.poll(() => document.querySelector("#playlist-bundle")).toBeTruthy();
    await expect.poll(() => document.querySelector("#playlist-download-zip").disabled).toBe(false);
    const zip = await commands.clickAndReadDownload("#playlist-download-zip");
    expect(zip.suggestedFilename).toBe("ff7.zip");
    const text = atob(zip.contentBase64);
    expect(text).toContain("ff7 (Disc 1).cue\nff7 (Disc 2).cue\n");
    expect(text).toContain('FILE "ff7 (Disc 1).bin" BINARY');
    expect(text).not.toContain("ff7.disc01");
    return;
  }

  // Stands in for the user picking the game's folder; the picker itself needs a person.
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => folder });
  mountForm();
  await expect.poll(() => buttonNamed("Open game folder")?.disabled).toBe(false);
  buttonNamed("Open game folder").click();
  await expect.poll(() => document.querySelector("#playlist-entries")?.textContent ?? "").toContain("ff7.disc02.cue");
  typeInto(document.querySelector("#playlist-name"), "Final Fantasy VII");
  (await enabledButton("#playlist-rename-discs")).click();
  await expect
    .poll(() => document.querySelector("#playlist-renames")?.textContent ?? "")
    .toContain("Final Fantasy VII (Disc 1).sbi");
  (await enabledButton("#playlist-rename")).click();
  await expect
    .poll(() => document.querySelector("#playlist-container")?.textContent ?? "")
    .toContain("Renamed 5 files");
  // The folder is read again, now with the new playlist beside the renamed discs.
  await expect
    .poll(() => document.querySelector("#playlist-entries")?.textContent ?? "")
    .toContain("Final Fantasy VII (Disc 2).cue");
  expect(document.querySelector('#playlist-container [role="alert"]')).toBeNull();

  expect(await listFolder(folder)).toEqual({
    "Final Fantasy VII (Disc 1).bin": new TextDecoder().decode(seed["ff7.disc01.bin"]),
    "Final Fantasy VII (Disc 1).cue": sheet("Final Fantasy VII (Disc 1).bin"),
    "Final Fantasy VII (Disc 1).sbi": "libcrypt",
    "Final Fantasy VII (Disc 2).bin": new TextDecoder().decode(seed["ff7.disc02.bin"]),
    "Final Fantasy VII (Disc 2).cue": sheet("Final Fantasy VII (Disc 2).bin"),
    "Final Fantasy VII.m3u": expect.stringMatching(
      /^Final Fantasy VII \(Disc 1\)\.cue\r?\nFinal Fantasy VII \(Disc 2\)\.cue/,
    ),
    "notes.txt": "keep",
  });
});

test("clears the rename choice when another folder is opened", async () => {
  if (!browserCanWriteFolders()) return;
  const root = await navigator.storage.getDirectory();
  folderName = `playlist-folder-${crypto.randomUUID()}`;
  const parent = await root.getDirectoryHandle(folderName, { create: true });
  const folders = [];
  for (const name of ["disc-set-a", "disc-set-b"]) {
    const folder = await parent.getDirectoryHandle(name, { create: true });
    await seedFolder(folder, ff7Files());
    folders.push(folder);
  }
  let opened = 0;
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => folders[opened++] });
  mountForm();
  await expect.poll(() => buttonNamed("Open game folder")?.disabled).toBe(false);
  buttonNamed("Open game folder").click();
  await expect.poll(() => document.querySelector("#playlist-entries")?.textContent ?? "").toContain("ff7.disc02.cue");
  (await enabledButton("#playlist-rename-discs")).click();
  await expect.poll(() => document.querySelector("#playlist-rename-discs").checked).toBe(true);

  buttonNamed("Open game folder").click();
  // The checkbox reads unchecked while a folder's plan is pending, so check it only once the new plan is in.
  await expect.poll(() => document.querySelector("#playlist-container")?.textContent ?? "").toContain("disc-set-b");
  await enabledButton("#playlist-rename-discs");
  expect(document.querySelector("#playlist-rename-discs").checked).toBe(false);
  expect(document.querySelector("#playlist-renames")).toBeNull();
});

test("plans a playlist for discs named only by number once a game name is typed", async () => {
  mountForm();
  const transfer = new DataTransfer();
  for (const [name, content] of [
    ["Disc 1.cue", sheet("Disc 1.bin")],
    ["Disc 1.bin", track(1)],
    ["Disc 2.cue", sheet("Disc 2.bin")],
    ["Disc 2.bin", track(2)],
  ]) {
    transfer.items.add(new File([content], name));
  }
  await expect.poll(() => document.querySelector("#playlist-input-picker")).toBeTruthy();
  const picker = document.querySelector("#playlist-input-picker");
  picker.files = transfer.files;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await expect
    .poll(() => document.querySelector('#playlist-container [role="alert"]')?.textContent ?? "")
    .toContain("Type a game name");
  typeInto(document.querySelector("#playlist-name"), "FF7");
  await enabledButton("#playlist-download-zip");
  const download = await commands.clickAndReadDownload("#playlist-download-zip");
  expect(download.suggestedFilename).toBe("FF7.zip");
  expect(atob(download.contentBase64)).toContain("Disc 1.cue\nDisc 2.cue\n");
});
