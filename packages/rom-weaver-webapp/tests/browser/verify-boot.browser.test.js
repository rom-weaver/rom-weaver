import { createElement } from "react";
import { beforeAll, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { runEmulatorBootCheck } from "../../src/public/react/components/emulator-boot-check.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  installPatcherTestHooks,
  mount,
  selectFileInput,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

// Applies an IPS patch to the generated NES sample with "Verify boot after
// Apply" off and then on. The check boots the result in a hidden EmulatorJS
// player, so the vendored EmulatorJS files MUST be present.

const CASE_TIMEOUT_MS = 120_000;
const SAMPLE_ROM_URL = "/hello-world.nes";
const EMULATORJS_DATA_PATH = "/emulatorjs/data/";
const INES_HEADER_BYTES = 16;
// Tile numbers of the sample's font: a space is tile 0 and a letter is its
// alphabet position (see scripts/first-sample-assets.mjs).
const toTiles = (message) => [...message].map((character) => (character === " " ? 0 : character.charCodeAt(0) - 64));
const SAMPLE_MESSAGE = " HELLO WORLD   ";
const PATCHED_MESSAGE = " HELLO WEAVER  ";

installPatcherTestHooks();

const indexOfSequence = (bytes, sequence, start = 0) => {
  for (let offset = start; offset <= bytes.length - sequence.length; offset += 1) {
    if (sequence.every((value, index) => bytes[offset + index] === value)) return offset;
  }
  return -1;
};

/** One IPS record that replaces `replacement.length` bytes at `offset`. */
const createIpsPatch = (offset, replacement) => {
  const header = new TextEncoder().encode("PATCH");
  const footer = new TextEncoder().encode("EOF");
  const record = new Uint8Array(5 + replacement.length);
  record.set([(offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff, 0, replacement.length]);
  record.set(replacement, 5);
  return new Uint8Array([...header, ...record, ...footer]);
};

const loadSampleFiles = async () => {
  const response = await fetch(SAMPLE_ROM_URL);
  if (!response.ok) throw new Error(`Could not fetch ${SAMPLE_ROM_URL}: HTTP ${response.status}`);
  const rom = new Uint8Array(await response.arrayBuffer());
  const messageOffset = indexOfSequence(rom, toTiles(SAMPLE_MESSAGE), INES_HEADER_BYTES);
  expect(messageOffset).toBeGreaterThan(INES_HEADER_BYTES);
  return {
    patch: new File([createIpsPatch(messageOffset, toTiles(PATCHED_MESSAGE))], "hello-to-weaver.ips"),
    rom: new File([rom], "hello-world.nes"),
  };
};

/**
 * Count the hidden boot check players the page creates. The player loads the
 * emulator core in its own frame, so the page's resource timings never show
 * the core; a player that never exists downloads nothing.
 */
const watchBootCheckFrames = () => {
  const frames = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLIFrameElement && node.classList.contains("emulator-boot-check-frame")) {
          frames.push(node);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return { frames, stop: () => observer.disconnect() };
};

const openOutputOptions = async () => {
  await expect.poll(() => document.querySelector(".outopts .cks-head")).toBeInstanceOf(HTMLElement);
  const head = document.querySelector(".outopts .cks-head");
  if (head.getAttribute("aria-expanded") !== "true") await userEvent.click(head);
  await expect.poll(() => document.getElementById("rom-weaver-checkbox-verify-boot")).toBeInstanceOf(HTMLInputElement);
};

const applyFiles = async ({ patch, rom }, compression = "none") => {
  mount(createElement(ApplyPatchForm, { defaultSettings: { output: { compression } } }));
  await expect.poll(() => document.getElementById("rom-weaver-input-file-unified")).not.toBeNull();
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), rom);
  selectFileInput(document.getElementById("rom-weaver-input-file-unified"), patch);
  await waitForApplyButtonEnabled();
};

const applySample = async () => applyFiles(await loadSampleFiles());

/** One blank FDS disk side, optionally behind the 16-byte `FDS\x1A` header. */
const createFdsImage = (headered) => {
  const headerBytes = headered ? 16 : 0;
  const image = new Uint8Array(headerBytes + 65_500);
  if (headered) image.set([...new TextEncoder().encode("FDS\x1a"), 1]);
  image.set([1, ...new TextEncoder().encode("*NINTENDO-HVC*")], headerBytes);
  return image;
};

// A real click gives the page the user activation that lets the hidden
// player's AudioContext run; a scripted click() would not.
const clickApply = async () => {
  await userEvent.click(document.getElementById("rom-weaver-button-apply"));
  const outcome = await waitForApplyOutcome();
  expect(outcome?.kind, outcome && "errorText" in outcome ? outcome.errorText : "").toBe("download");
};

beforeAll(async () => {
  const response = await fetch(`${EMULATORJS_DATA_PATH}loader.js`, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`EmulatorJS assets are missing (HTTP ${response.status}). Run: node scripts/ensure-emulatorjs.mjs`);
  }
});

test(
  "Apply with Verify boot off loads no emulator, and ticking it later checks the result",
  async () => {
    await applySample();
    await openOutputOptions();
    expect(document.getElementById("rom-weaver-checkbox-verify-boot").checked).toBe(false);
    const watcher = watchBootCheckFrames();
    try {
      await clickApply();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      watcher.stop();
    }
    expect(document.getElementById("rom-weaver-boot-check")).toBeNull();
    expect(watcher.frames).toEqual([]);

    // Ticking the option under the finished result checks that result.
    await userEvent.click(document.getElementById("rom-weaver-checkbox-verify-boot"));
    await expect
      .poll(() => document.getElementById("rom-weaver-boot-check")?.getAttribute("data-state"), { timeout: 60_000 })
      .toBe("boots");
  },
  CASE_TIMEOUT_MS,
);

test(
  "Apply with Verify boot on boots the patched NES sample",
  async () => {
    await applySample();
    await openOutputOptions();
    // The Apply option is a session override, so the previous case can leave it on.
    const option = document.getElementById("rom-weaver-checkbox-verify-boot");
    if (!option.checked) await userEvent.click(option);
    expect(option.checked).toBe(true);
    const watcher = watchBootCheckFrames();
    try {
      await clickApply();
      await expect
        .poll(() => document.getElementById("rom-weaver-boot-check")?.getAttribute("data-state"), { timeout: 60_000 })
        .toBe("boots");
    } finally {
      watcher.stop();
    }
    expect(document.getElementById("rom-weaver-boot-check")?.textContent).toContain("Boots");
    expect(watcher.frames).toHaveLength(1);
    expect(watcher.frames[0]?.isConnected).toBe(false);
  },
  CASE_TIMEOUT_MS,
);

// The FDS core crashes the tab without the BIOS the site does not supply, so
// the check MUST NOT start it, whether the name or only the bytes say FDS.
for (const { fileName, headered } of [
  { fileName: "disk.fds", headered: true },
  { fileName: "disk.nes", headered: false },
]) {
  test(
    `Apply with Verify boot on never boots a Famicom Disk System image named ${fileName}`,
    async () => {
      await applyFiles({
        patch: new File([createIpsPatch(64, [0x42])], "disk.ips"),
        rom: new File([createFdsImage(headered)], fileName),
      });
      await openOutputOptions();
      const option = document.getElementById("rom-weaver-checkbox-verify-boot");
      if (!option.checked) await userEvent.click(option);
      const watcher = watchBootCheckFrames();
      try {
        await clickApply();
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } finally {
        watcher.stop();
      }
      expect(document.getElementById("rom-weaver-boot-check")).toBeNull();
      expect(watcher.frames).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
}

test("the boot check names a PlayStation .bin track the way the Test player does", async () => {
  const checksum = "a".repeat(40);
  const frames = [];
  const controller = new AbortController();
  const check = runEmulatorBootCheck({
    checksum,
    core: "psx",
    dataUrl: EMULATORJS_DATA_PATH,
    fileName: "Game (Track 1).bin",
    // A detached host: the player never loads, so only its document is checked.
    host: { append: (frame) => frames.push(frame) },
    rom: new Blob([new Uint8Array(16)]),
    signal: controller.signal,
  });
  await expect.poll(() => frames.length).toBe(1);
  controller.abort();
  await expect(check).rejects.toMatchObject({ name: "AbortError" });
  expect(frames[0].srcdoc).toContain(`${checksum}.bin`);
});

// A zip output hides the FDS image until the check extracts it, so the
// extracted ROM MUST pass the same gate.
test(
  "Apply with Verify boot on never boots a Famicom Disk System image inside a zip output",
  async () => {
    await applyFiles(
      {
        patch: new File([createIpsPatch(64, [0x42])], "disk.ips"),
        rom: new File([createFdsImage(false)], "disk.nes"),
      },
      "zip",
    );
    await openOutputOptions();
    const option = document.getElementById("rom-weaver-checkbox-verify-boot");
    if (!option.checked) await userEvent.click(option);
    const watcher = watchBootCheckFrames();
    try {
      await clickApply();
      // The check shows Checking while it extracts the zip, then nothing.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await expect.poll(() => document.getElementById("rom-weaver-boot-check"), { timeout: 30_000 }).toBeNull();
    } finally {
      watcher.stop();
    }
    expect(document.getElementById("rom-weaver-boot-check")).toBeNull();
    expect(watcher.frames).toEqual([]);
  },
  CASE_TIMEOUT_MS,
);
