import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { planBrowserPlaylist } from "../../src/platform/browser/browser-playlist-api.ts";
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

test("renames the discs in the picked folder where the browser can move files, and points to the CLI elsewhere", async () => {
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
    const download = await commands.clickAndReadDownload("#playlist-download");
    expect(download.suggestedFilename).toBe("ff7.m3u");
    expect(lines(atob(download.contentBase64))).toEqual(["ff7.disc01.cue", "ff7.disc02.cue"]);
    expect(document.querySelector("#playlist-save-folder").disabled).toBe(true);
    expect(document.querySelector("#playlist-rename-discs").disabled).toBe(true);
    expect(document.querySelector('#playlist-container a[href$="docs/cli-playlist#rename-the-discs"]')).toBeTruthy();
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
  await enabledButton("#playlist-download");
  const download = await commands.clickAndReadDownload("#playlist-download");
  expect(download.suggestedFilename).toBe("FF7.m3u");
  expect(lines(atob(download.contentBase64))).toEqual(["Disc 1.cue", "Disc 2.cue"]);
});
