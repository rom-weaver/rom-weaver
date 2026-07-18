import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { ExtractDrawer, ExtractionTree } from "../../src/public/react/components/ds/extraction-tree.tsx";

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

test("extraction tree omits ratio for CUE sidecar outputs", async () => {
  mount(
    createElement(ExtractionTree, {
      levels: [
        { name: "game.chd", sizeBytes: 1000, sizeLabel: "1.0 KB" },
        { name: "game.cue", sizeBytes: 100, sizeLabel: "100 B" },
      ],
    }),
  );

  await expect
    .poll(() => document.querySelector(".extract-d .rb:not(.time)")?.textContent || "")
    .toBe("1.0 KB \u2192 100 B");
});

test("extraction tree keeps ratio for ROM extraction outputs", async () => {
  mount(
    createElement(ExtractionTree, {
      levels: [
        { name: "roms.zip", sizeBytes: 1000, sizeLabel: "1.0 KB" },
        { name: "game.bin", sizeBytes: 100, sizeLabel: "100 B" },
      ],
    }),
  );

  await expect
    .poll(() => document.querySelector(".extract-d .rb:not(.time)")?.textContent || "")
    .toBe("1.0 KB \u2192 100 B (1000%)");
});

test("extraction tree keeps extract metadata for prepared single-level inputs", async () => {
  mount(
    createElement(ExtractionTree, {
      levels: [{ name: "game.iso", sizeBytes: 4096, sizeLabel: "4.1 KB" }],
      timing: "1.2 s",
    }),
  );

  await expect.poll(() => document.querySelector(".extract-d .lab")?.textContent || "").toBe("Files");
  expect(document.querySelector(".extract-d .rb:not(.time)")?.textContent || "").toBe("4.1 KB");
  expect(document.querySelector(".extract-d .rb.time")?.textContent || "").toBe("Extract 1.2 s");
  expect(document.querySelector(".extract-d .tree-name")?.textContent || "").toBe("game.iso");
});

test("extraction tree stays compact for raw single-file inputs", async () => {
  mount(
    createElement(ExtractionTree, {
      levels: [{ name: "game.bin", sizeBytes: 4096, sizeLabel: "4.1 KB" }],
    }),
  );

  await expect.poll(() => document.querySelector(".nmline .nm")?.textContent || "").toBe("game.bin");
  expect(document.querySelector(".extract-d")).toBeNull();
});

test("files drawer lists sibling disc files below archive provenance", async () => {
  mount(
    createElement(ExtractDrawer, {
      always: true,
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
  expect(Array.from(document.querySelectorAll(".extract-d .tree-row")).map((row) => row.className)).toEqual([
    "tree-row d0",
    "tree-row d1",
    "tree-row d1",
    "tree-row d1",
  ]);
});
