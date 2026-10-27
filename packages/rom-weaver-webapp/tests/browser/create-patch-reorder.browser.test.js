import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { commands } from "vitest/browser";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/apply-patch-form.tsx";
import { installPatcherTestHooks, mount } from "./patcher-test-shared.js";

installPatcherTestHooks();

const ips = (records) =>
  new Uint8Array([
    ...new TextEncoder().encode("PATCH"),
    ...records.flatMap(([offset, value]) => [offset >> 16, (offset >> 8) & 255, offset & 255, 0, 1, value]),
    ...new TextEncoder().encode("EOF"),
  ]);

const patchNames = () =>
  [...document.querySelectorAll("#rom-weaver-list-patch-stack .card.file")].map((card) =>
    card.querySelector(".nmline").dataset.fileName === "02-second.ips" ? "second" : "first",
  );

const patchFileNames = () =>
  [...document.querySelectorAll("#rom-weaver-list-patch-stack .card.file")].map(
    (card) => card.querySelector(".nmline").dataset.fileName,
  );

// Packs files into a zip through the real compression runtime.
const buildZip = async (entries, outputName) => {
  const result = await browserRuntime.compression.create({
    entries,
    format: "zip",
    options: { outputName, threads: 1 },
  });
  try {
    const blob = await browserRuntime.publicOutput.getBlob(result.output);
    return new File([await blob.arrayBuffer()], outputName, { type: "application/zip" });
  } finally {
    await result.output.dispose().catch(() => undefined);
  }
};

test.each(["reading", "settled"])("Create preserves a reorder while inputs are %s", async (timing) => {
  const original = Uint8Array.from({ length: 4096 }, (_, index) => (index * 17 + 11) % 256);
  const expected = original.slice();
  expected[3] = 0xaa;
  expected[1024] = 0xdd;
  expected[2048] = 0xbb;
  const rom = new File([original], "original.bin");
  const patches = [
    new File(
      [
        ips([
          [3, 0xaa],
          [2048, 0xbb],
        ]),
      ],
      "01-first.ips",
    ),
    new File(
      [
        ips([
          [3, 0xcc],
          [1024, 0xdd],
        ]),
      ],
      "02-second.ips",
    ),
  ];
  let release = () => undefined;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const ingest = browserRuntime.ingest.run;
  const delayedIngest = vi.spyOn(browserRuntime.ingest, "run").mockImplementation(async (input) => {
    await barrier;
    return ingest(input);
  });
  const reapplier = new ApplyWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    mount(
      createElement(ApplyPatchForm, {
        mode: "create",
        defaultInputs: [rom],
        defaultPatches: patches,
        threads: 1,
      }),
    );
    await expect.poll(() => delayedIngest.mock.calls.length).toBeGreaterThan(0);
    await expect.poll(() => document.querySelectorAll("#rom-weaver-list-patch-stack .stage-status").length).toBe(2);
    if (timing === "settled") {
      release();
      await expect.poll(() => document.querySelectorAll(".stage-status").length).toBe(0);
    }
    document.getElementById("rom-weaver-patch-menu-1").click();
    document.getElementById("rom-weaver-patch-move-up-1").click();
    await expect.poll(patchNames).toEqual(["second", "first"]);
    release();
    await expect.poll(() => document.querySelectorAll(".stage-status").length).toBe(0);
    await expect.poll(patchNames).toEqual(["second", "first"]);
    const create = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Create patch & download"),
    );
    expect(create).toBeInstanceOf(HTMLButtonElement);
    create.id = "create-reordered-patch";
    const download = await commands.clickAndReadDownload("#create-reordered-patch");
    expect(download.suggestedFilename).toContain("02-second");
    const combined = Uint8Array.from(atob(download.contentBase64), (character) => character.charCodeAt(0));
    await reapplier.setInput(rom);
    await reapplier.addPatch(new File([combined], "combined.bps"));
    const result = await reapplier.run();
    try {
      const blob = await result.output.getBlob();
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(expected);
    } finally {
      await result.output.dispose();
    }
  } finally {
    release();
    delayedIngest.mockRestore();
    await reapplier.dispose();
  }
});

test("Create keeps a sidecar patch discovered while the user reorders patches", async () => {
  const original = Uint8Array.from({ length: 4096 }, (_, index) => (index * 17 + 11) % 256);
  const expected = original.slice();
  expected[3] = 0xaa;
  expected[1024] = 0xdd;
  expected[2048] = 0xbb;
  expected[3000] = 0xee;
  const rom = await buildZip(
    [
      { file: new File([original], "original.bin"), fileName: "original.bin" },
      { file: new File([ips([[3000, 0xee]])], "sidecar.ips"), fileName: "sidecar.ips" },
    ],
    "original.zip",
  );
  const plainRom = new File([original], "original.bin");
  const patches = [
    new File(
      [
        ips([
          [3, 0xaa],
          [2048, 0xbb],
        ]),
      ],
      "01-first.ips",
    ),
    new File(
      [
        ips([
          [3, 0xcc],
          [1024, 0xdd],
        ]),
      ],
      "02-second.ips",
    ),
  ];
  let release = () => undefined;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const ingest = browserRuntime.ingest.run;
  const delayedIngest = vi.spyOn(browserRuntime.ingest, "run").mockImplementation(async (input) => {
    await barrier;
    return ingest(input);
  });
  const reapplier = new ApplyWorkflow({ settings: { output: { compression: "none" }, workers: { threads: 1 } } });
  try {
    mount(
      createElement(ApplyPatchForm, {
        mode: "create",
        defaultInputs: [rom],
        defaultPatches: patches,
        threads: 1,
      }),
    );
    await expect.poll(() => delayedIngest.mock.calls.length).toBeGreaterThan(0);
    await expect.poll(() => document.querySelectorAll("#rom-weaver-list-patch-stack .stage-status").length).toBe(2);
    document.getElementById("rom-weaver-patch-menu-1").click();
    document.getElementById("rom-weaver-patch-move-up-1").click();
    await expect.poll(patchNames).toEqual(["second", "first"]);
    release();
    await expect.poll(() => document.querySelectorAll(".stage-status").length).toBe(0);
    await expect.poll(patchFileNames).toEqual(["02-second.ips", "01-first.ips", "sidecar.ips"]);
    const create = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Create patch & download"),
    );
    expect(create).toBeInstanceOf(HTMLButtonElement);
    create.id = "create-reordered-patch";
    const download = await commands.clickAndReadDownload("#create-reordered-patch");
    const combined = Uint8Array.from(atob(download.contentBase64), (character) => character.charCodeAt(0));
    await reapplier.setInput(plainRom);
    await reapplier.addPatch(new File([combined], "combined.bps"));
    const result = await reapplier.run();
    try {
      const blob = await result.output.getBlob();
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(expected);
    } finally {
      await result.output.dispose();
    }
  } finally {
    release();
    delayedIngest.mockRestore();
    await reapplier.dispose();
  }
});
