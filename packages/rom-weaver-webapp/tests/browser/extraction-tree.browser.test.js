import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { ExtractDrawer } from "../../src/public/react/components/ds/extraction-tree.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

let mountedRoot = null;

const getRoot = () => {
  const existing = document.getElementById("app");
  if (existing) return existing;
  const element = document.createElement("div");
  element.id = "app";
  document.body.appendChild(element);
  return element;
};

const mount = (element) => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  const root = createRoot(getRoot());
  root.render(element);
  mountedRoot = root;
  return root;
};

afterEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  document.body.innerHTML = "";
});

test("files drawer omits ratio for CUE sidecar outputs", async () => {
  mount(
    createElement(ExtractDrawer, {
      fileName: "game.cue",
      fileSize: 100,
      parentCompressions: [{ fileName: "game.chd", sourceSize: 1000 }],
    }),
  );

  await expect
    .poll(() => document.querySelector(".extract-d .rb:not(.time)")?.textContent || "")
    .toBe("1.0 KB \u2192 100 B");
  expect(document.querySelector(".extract-size-source")?.textContent || "").toBe("1.0 KB");
});

test("files drawer keeps ratio for ROM extraction outputs", async () => {
  mount(
    createElement(ExtractDrawer, {
      fileName: "game.bin",
      fileSize: 100,
      parentCompressions: [{ fileName: "roms.zip", sourceSize: 1000 }],
    }),
  );

  await expect
    .poll(() => document.querySelector(".extract-d .rb:not(.time)")?.textContent || "")
    .toBe("1.0 KB \u2192 100 B (1000%)");
});

test("files drawer keeps the ROM size when the chain already names the leaf", async () => {
  mount(
    createElement(ExtractDrawer, {
      fileName: "game.bin",
      fileSize: 4096,
      parentCompressions: [{ fileName: "game.bin" }],
      typeLabel: "NES",
    }),
  );

  await expect.poll(() => document.querySelector(".extract-d .rb:not(.time)")?.textContent || "").toBe("4.1 KB");
  expect(Array.from(document.querySelectorAll(".extract-d .rb:not(.time)"), (entry) => entry.textContent)).toEqual([
    "4.1 KB",
    "NES",
  ]);
  expect(document.querySelector(".extract-d .tree-size")?.textContent || "").toBe("4.1 KB");
});

test("files drawer keeps extract metadata for prepared single-level inputs", async () => {
  mount(
    createElement(ExtractDrawer, {
      fileName: "game.iso",
      fileSize: 4096,
      timing: "1.2 s",
      typeLabel: "ISO",
    }),
  );

  await expect.poll(() => document.querySelector(".extract-d .lab")?.textContent || "").toBe("Files");
  expect(document.querySelector(".extract-d .rb:not(.time)")?.textContent || "").toBe("4.1 KB");
  expect(Array.from(document.querySelectorAll(".extract-d .rb:not(.time)"), (entry) => entry.textContent)).toEqual([
    "4.1 KB",
    "ISO",
  ]);
  expect(document.querySelector(".extract-d .rb.time")?.textContent || "").toBe("Extract 1.2 s");
  expect(document.querySelector(".extract-d .tree-name")?.textContent || "").toBe("game.iso");
});

test("files drawer formats sizes with the selected locale", async () => {
  mount(
    createElement(
      RomWeaverSettingsProvider,
      { settings: { language: "de" } },
      createElement(ExtractDrawer, { fileName: "game.bin", fileSize: 4096 }),
    ),
  );

  await expect.poll(() => document.querySelector(".extract-d .rb:not(.time)")?.textContent || "").toBe("4,1 KB");
  expect(document.querySelector(".extract-d .tree-size")?.textContent || "").toBe("4,1 KB");
});

test("files drawer stays available for raw single-file inputs", async () => {
  mount(
    createElement(ExtractDrawer, {
      fileName: "game.bin",
      fileSize: 4096,
    }),
  );

  await expect.poll(() => document.querySelector(".extract-d .lab")?.textContent || "").toBe("Files");
  expect(document.querySelector(".extract-d .rb:not(.time)")?.textContent || "").toBe("4.1 KB");
  expect(document.querySelector(".extract-d .tree-name")?.textContent || "").toBe("game.bin");
});

test("files drawer lists sibling disc files below archive provenance", async () => {
  mount(
    createElement(ExtractDrawer, {
      fileEntries: [
        { fileName: "game.cue", fileSize: 64 },
        { fileName: "game.bin", fileSize: 4096 },
        { fileName: "game (Track 2).bin", fileSize: 2048 },
      ],
      fileSize: 6208,
      fileName: "game.bin",
      parentCompressions: [{ fileName: "disc.7z", sourceSize: 8192, outputSize: 6208 }],
    }),
  );

  await expect.poll(() => document.querySelector(".extract-d .lab")?.textContent || "").toBe("Files");
  expect(document.querySelector(".extract-d .rb:not(.time)")?.textContent || "").toContain("→");
  document.querySelector(".extract-d .cks-head")?.click();
  await expect
    .poll(() =>
      Array.from(document.querySelectorAll(".extract-d .tree-name")).map((entry) => entry.textContent?.trim()),
    )
    .toEqual(["disc.7z", "game.cue", "game.bin", "game (Track 2).bin"]);
  const rows = Array.from(document.querySelectorAll(".extract-d .tree-row"));
  expect(rows.map((row) => row.getAttribute("data-depth"))).toEqual(["0", "1", "1", "1"]);
  // The named file is the leaf; the guide line stops on the last entry at that depth.
  expect(rows.map((row) => row.classList.contains("is-leaf"))).toEqual([false, false, true, false]);
  expect(rows.map((row) => row.classList.contains("is-last"))).toEqual([true, false, false, true]);
});

test("files drawer totals multi-extract sizes when the output size is missing", async () => {
  mount(
    createElement(ExtractDrawer, {
      fileEntries: [
        { fileName: "game.cue", fileSize: 100 },
        { fileName: "game.bin", fileSize: 300 },
      ],
      fileName: "game.bin",
      parentCompressions: [{ fileName: "game.zip", sourceSize: 1000 }],
    }),
  );

  await expect
    .poll(() => document.querySelector(".extract-d .rb:not(.time)")?.textContent || "")
    .toBe("1.0 KB → 400 B (250%)");
});

test("files drawer omits invalid source sizes from the summary", async () => {
  mount(
    createElement(ExtractDrawer, {
      fileEntries: [{ fileName: "game.bin", fileSize: 100 }],
      fileName: "game.bin",
      fileSize: 100,
      parentCompressions: [{ fileName: "game.zip", sourceSize: Number.POSITIVE_INFINITY }],
    }),
  );

  await expect.poll(() => document.querySelector(".extract-d .rb:not(.time)")?.textContent || "").toBe("100 B");
});
