import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { releaseBrowserSource, retainBrowserSource } from "../../src/storage/browser/browser-source-primitives.ts";
import { loadWeaveUrlSession } from "../../src/webapp/url-session/weave-url-session.ts";
import {
  clickApplyButton,
  getPatchStackFileNames,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForInputStackFileName,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const WEAVE_URL = `${location.origin}/virtual/weave/weave.zip`;

// The everything-archive: a zip carrying the rom-weaver-weave.json plus its ROM and patch as members (referenced
// via weave-relative `path` entries), assembled in the browser through the real compression
// runtime so the test exercises exactly what a distributor would publish.
const buildEverythingArchive = async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const weave = {
    output: { name: "bundled-output" },
    patches: [{ path: "change.ips" }],
    rom: { path: "game.bin" },
    version: 1,
  };
  const weaveFile = new File([JSON.stringify(weave)], "rom-weaver-weave.json", { type: "application/json" });
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");
  const result = await create({
    entries: [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: romFile, fileName: "game.bin" },
      { file: patchFile, fileName: "change.ips" },
    ],
    format: "zip",
    options: { outputName: "weave.zip", threads: 1 },
  });
  const output = result?.output;
  if (!output) throw new Error("Weave compression did not return output");
  try {
    // Materialize the bytes before dispose() deletes the backing OPFS file - a
    // File built straight from the blob references that file lazily, and reads
    // during the later drop intermittently fail once it is gone.
    const blob = await browserRuntime.publicOutput.getBlob(output);
    const bytes = await blob.arrayBuffer();
    return new File([bytes], "weave.zip", { type: "application/zip" });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

test("weave create keeps its operation scope until the last output is disposed", async () => {
  const create = browserRuntime.weave?.create;
  if (!create) throw new Error("Runtime weave create capability is unavailable");
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const created = await create({
    weaveFileName: "scoped-weave.zip",
    noWeaveRom: true,
    patches: [{ fileName: "change.ips", source: patchFile }],
    rom: { fileName: "game.bin", source: romFile },
  });
  const { archiveOutput, weaveOutput } = created;
  if (!archiveOutput) throw new Error("Weave create did not return an archive output");
  const scopePath = weaveOutput.path.replace(/\/[^/]+$/, "");
  try {
    expect(weaveOutput.path).toMatch(/^\/work\/operations\/[^/]+\/rom-weaver-weave\.json$/);
    expect(archiveOutput.path).toBe(`${scopePath}/scoped-weave.zip`);
    expect(await browserVfs.stat(weaveOutput.path)).not.toBeNull();
    expect(await browserVfs.stat(archiveOutput.path)).not.toBeNull();

    await weaveOutput.dispose();
    expect(await browserVfs.stat(weaveOutput.path)).toBeNull();
    expect(await browserVfs.stat(archiveOutput.path)).not.toBeNull();

    await archiveOutput.dispose();
    await expect
      .poll(() => Promise.all([browserVfs.stat(weaveOutput.path), browserVfs.stat(archiveOutput.path)]))
      .toEqual([null, null]);
  } finally {
    await Promise.all([weaveOutput.dispose(), archiveOutput.dispose()]);
  }
});

test("weave parse cleanup keeps extracted members an Apply workflow owns until it is disposed", async () => {
  const weaveFile = await buildEverythingArchive();
  const parse = browserRuntime.weave?.parse;
  if (!parse) throw new Error("Runtime weave parse capability is unavailable");
  const parsed = await parse({ fileName: weaveFile.name, source: weaveFile });
  const extracted = [...parsed.extractedFiles.values()];
  const romFile = extracted.find((file) => file.name === "game.bin");
  const patchFile = extracted.find((file) => file.name === "change.ips");
  if (!(romFile && patchFile)) throw new Error("Weave parse did not extract game.bin and change.ips");
  const extractedPaths = [romFile.filePath, patchFile.filePath];
  const workflow = new ApplyWorkflow({
    settings: {
      output: { compression: "none", outputName: "patched.bin" },
      workers: { threads: 1 },
    },
  });
  let disposed = false;
  try {
    await workflow.setInput(romFile);
    await workflow.addPatch(patchFile);
    await parsed.cleanup();
    expect(await Promise.all(extractedPaths.map((path) => browserVfs.stat(path)))).not.toContain(null);

    const applied = await workflow.run();
    await applied.output.dispose();

    await workflow.dispose();
    disposed = true;
    await expect.poll(() => Promise.all(extractedPaths.map((path) => browserVfs.stat(path)))).toEqual([null, null]);
  } finally {
    if (!disposed) await workflow.dispose();
    await parsed.cleanup();
  }
});

test.each([
  { name: "the parse owner never releases", steps: ["workflowTakes", "formReleases"] },
  { name: "the form releases before the parse owner", steps: ["workflowTakes", "formReleases", "parseCleanup"] },
  { name: "the parse owner releases before the form", steps: ["workflowTakes", "parseCleanup", "formReleases"] },
  {
    name: "the parse owner releases before the workflow takes the patch",
    steps: ["parseCleanup", "workflowTakes", "formReleases"],
  },
  {
    name: "the workflow takes the patch again after clearing it",
    steps: ["workflowTakes", "workflowClears", "workflowTakes", "parseCleanup", "formReleases"],
  },
])("keeps a weave-extracted patch until the Apply workflow is disposed when $name", async ({ steps }) => {
  const weaveFile = await buildEverythingArchive();
  const parse = browserRuntime.weave?.parse;
  if (!parse) throw new Error("Runtime weave parse capability is unavailable");
  const parsed = await parse({ fileName: weaveFile.name, source: weaveFile });
  const patchFile = [...parsed.extractedFiles.values()].find((file) => file.name === "change.ips");
  if (!patchFile) throw new Error("Weave parse did not extract change.ips");
  const workflow = new ApplyWorkflow({ settings: { workers: { threads: 1 } } });
  const runStep = {
    formReleases: () => releaseBrowserSource(patchFile),
    parseCleanup: () => parsed.cleanup(),
    workflowClears: async () => {
      await workflow.clearPatches();
      // The workflow returns its reference one task later. Waiting lets the next add take a new one.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    workflowTakes: () => workflow.addPatch(patchFile),
  };
  let disposed = false;
  retainBrowserSource(patchFile);
  try {
    for (const step of steps) await runStep[step]();
    expect((await browserVfs.stat(patchFile.filePath))?.size).toBe(14);

    await workflow.dispose();
    disposed = true;
    await expect.poll(() => browserVfs.stat(patchFile.filePath)).toBeNull();
  } finally {
    if (!disposed) await workflow.dispose();
    await parsed.cleanup();
  }
});

test("everything-archive weave extracts its members and applies to a download", async () => {
  const weaveFile = await buildEverythingArchive();

  // Direct runtime parse over the archive: members must be materialized under extracted paths and
  // the bundled patch must carry its ingest-grade descriptor (no second describe round-trip).
  const parse = browserRuntime.weave?.parse;
  if (!parse) throw new Error("Runtime weave parse capability is unavailable");
  const readSpy = vi.spyOn(browserVfs, "read");
  const parsed = await parse({ fileName: weaveFile.name, source: weaveFile });
  const secondParsed = await parse({ fileName: weaveFile.name, source: weaveFile });
  expect(parsed.result.sourceKind).toBe("archive");
  expect(parsed.result.romSource?.kind).toBe("extracted");
  expect(parsed.result.patchSources).toHaveLength(1);
  const patchSource = parsed.result.patchSources[0];
  expect(patchSource.source.kind).toBe("extracted");
  expect(patchSource.descriptor?.fileName).toBe("change.ips");
  expect(patchSource.descriptor?.isValidPatch).toBe(true);
  expect(parsed.extractedFiles.size).toBe(2);
  const extractedPatch =
    patchSource.source.kind === "extracted" ? parsed.extractedFiles.get(patchSource.source.extractedPath) : undefined;
  expect(extractedPatch?.name).toBe("change.ips");
  expect(extractedPatch?.filePath).toBe(patchSource.source.extractedPath);
  expect(await extractedPatch?.arrayBuffer()).toHaveProperty("byteLength", 14);
  expect(readSpy).not.toHaveBeenCalled();
  const firstPaths = [...parsed.extractedFiles.keys()];
  const secondPaths = [...secondParsed.extractedFiles.keys()];
  expect(firstPaths.every((path) => path.includes("/weave-parse/"))).toBe(true);
  expect(new Set([...firstPaths, ...secondPaths])).toHaveLength(4);
  expect(await Promise.all([...firstPaths, ...secondPaths].map((path) => browserVfs.stat(path)))).not.toContain(null);
  await Promise.all([parsed.cleanup(), secondParsed.cleanup()]);
  await expect
    .poll(async () => Promise.all([...firstPaths, ...secondPaths].map((path) => browserVfs.stat(path))))
    .toEqual([null, null, null, null]);
  readSpy.mockRestore();

  // Full boot flow over the same archive fetched from a URL (stubbed - the fixture is virtual).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url === WEAVE_URL) {
      return weaveFile
        .arrayBuffer()
        .then((bytes) => new Response(bytes, { headers: { "content-type": "application/zip" }, status: 200 }));
    }
    return originalFetch(input, init);
  };
  let loaded;
  try {
    loaded = await loadWeaveUrlSession(WEAVE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const { files, session } = loaded;
  expect(files.map((file) => file.name)).toEqual(["game.bin", "change.ips"]);
  const loadedPaths = files.map((file) => file.filePath);
  expect(await Promise.all(loadedPaths.map((path) => browserVfs.stat(path)))).not.toContain(null);
  expect(session.name).toBe("bundled-output");
  expect(session.entries.map((entry) => entry.optional)).toEqual([false]);

  mount(
    createElement(ApplyPatchForm, {
      weaveSession: session,
      pageDrop: { files, id: 1 },
    }),
  );
  // Let the page-drop session enqueue its initial input/patch staging batch before polling the UI.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await waitForInputStackFileName();
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips"]);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome).toEqual({ kind: "download" });
  mount(createElement("div"));
  await expect.poll(async () => Promise.all(loadedPaths.map((path) => browserVfs.stat(path)))).toEqual([null, null]);
  await loaded.cleanup();
});
