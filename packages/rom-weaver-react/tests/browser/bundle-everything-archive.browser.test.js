import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { loadBundleUrlSession } from "../../src/webapp/url-session/bundle-url-session.ts";
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

const BUNDLE_URL = `${location.origin}/virtual/bundle/bundle.zip`;

// The everything-archive: a zip carrying the rom-weaver-bundle.json plus its ROM and patch as members (referenced
// via bundle-relative `path` entries), assembled in the browser through the real compression
// runtime so the test exercises exactly what a distributor would publish.
const buildEverythingArchive = async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const bundle = {
    output: { name: "bundled-output" },
    patches: [{ path: "change.ips" }],
    rom: { path: "game.bin" },
    version: 1,
  };
  const bundleFile = new File([JSON.stringify(bundle)], "rom-weaver-bundle.json", { type: "application/json" });
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");
  const result = await create({
    entries: [
      { file: bundleFile, fileName: "rom-weaver-bundle.json" },
      { file: romFile, fileName: "game.bin" },
      { file: patchFile, fileName: "change.ips" },
    ],
    format: "zip",
    options: { outputName: "bundle.zip", workerThreads: 1 },
  });
  const output = result?.output;
  if (!output) throw new Error("Bundle compression did not return output");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], "bundle.zip", { type: "application/zip" });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

test("bundle create keeps its operation scope until the last output is disposed", async () => {
  const create = browserRuntime.bundle?.create;
  if (!create) throw new Error("Runtime bundle create capability is unavailable");
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const created = await create({
    bundleFileName: "scoped-bundle.zip",
    noBundleRom: true,
    patches: [{ fileName: "change.ips", source: patchFile }],
    rom: { fileName: "game.bin", source: romFile },
  });
  const { archiveOutput, bundleOutput } = created;
  if (!archiveOutput) throw new Error("Bundle create did not return an archive output");
  const scopePath = bundleOutput.path.replace(/\/[^/]+$/, "");
  try {
    expect(bundleOutput.path).toMatch(/^\/work\/operations\/[^/]+\/rom-weaver-bundle\.json$/);
    expect(archiveOutput.path).toBe(`${scopePath}/scoped-bundle.zip`);
    expect(await browserVfs.stat(bundleOutput.path)).not.toBeNull();
    expect(await browserVfs.stat(archiveOutput.path)).not.toBeNull();

    await bundleOutput.dispose();
    expect(await browserVfs.stat(bundleOutput.path)).toBeNull();
    expect(await browserVfs.stat(archiveOutput.path)).not.toBeNull();

    await archiveOutput.dispose();
    await expect
      .poll(() => Promise.all([browserVfs.stat(bundleOutput.path), browserVfs.stat(archiveOutput.path)]))
      .toEqual([null, null]);
  } finally {
    await Promise.all([bundleOutput.dispose(), archiveOutput.dispose()]);
  }
});

test("everything-archive bundle extracts its members and applies to a download", async () => {
  const bundleFile = await buildEverythingArchive();

  // Direct runtime parse over the archive: members must be materialized under extracted paths and
  // the bundled patch must carry its ingest-grade descriptor (no second describe round-trip).
  const parse = browserRuntime.bundle?.parse;
  if (!parse) throw new Error("Runtime bundle parse capability is unavailable");
  const readSpy = vi.spyOn(browserVfs, "read");
  const parsed = await parse({ fileName: bundleFile.name, source: bundleFile });
  const secondParsed = await parse({ fileName: bundleFile.name, source: bundleFile });
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
  expect(firstPaths.every((path) => path.includes("/bundle-parse/"))).toBe(true);
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
    if (url === BUNDLE_URL) {
      return bundleFile
        .arrayBuffer()
        .then((bytes) => new Response(bytes, { headers: { "content-type": "application/zip" }, status: 200 }));
    }
    return originalFetch(input, init);
  };
  let loaded;
  try {
    loaded = await loadBundleUrlSession(BUNDLE_URL);
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
      bundleSession: session,
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
