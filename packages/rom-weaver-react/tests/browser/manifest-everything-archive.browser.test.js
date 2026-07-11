import { createElement } from "react";
import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { loadManifestUrlSession } from "../../src/webapp/url-session/manifest-url-session.ts";
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
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const BUNDLE_URL = `${location.origin}/virtual/manifest/bundle.zip`;

// The everything-archive: a zip carrying the rw.json plus its ROM and patch as members (referenced
// via manifest-relative `path` entries), assembled in the browser through the real compression
// runtime so the test exercises exactly what a distributor would publish.
const buildEverythingArchive = async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const manifest = {
    output: { name: "bundled-output" },
    patches: [{ path: "change.ips" }],
    rom: { path: "game.bin" },
    version: 1,
  };
  const manifestFile = new File([JSON.stringify(manifest)], "rw.json", { type: "application/json" });
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");
  const result = await create({
    entries: [
      { file: manifestFile, fileName: "rw.json" },
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

test("everything-archive manifest extracts its members and applies to a download", async () => {
  const bundleFile = await buildEverythingArchive();

  // Direct runtime parse over the archive: members must be materialized under extracted paths and
  // the bundled patch must carry its ingest-grade descriptor (no second describe round-trip).
  const parse = browserRuntime.manifest?.parse;
  if (!parse) throw new Error("Runtime manifest parse capability is unavailable");
  const parsed = await parse({ fileName: bundleFile.name, source: bundleFile });
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
    loaded = await loadManifestUrlSession(BUNDLE_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const { files, session } = loaded;
  expect(files.map((file) => file.name)).toEqual(["game.bin", "change.ips"]);
  expect(session.name).toBe("bundled-output");
  expect(session.entries.map((entry) => entry.optional)).toEqual([false]);

  mount(
    createElement(ApplyPatchForm, {
      manifestSession: session,
      pageDrop: { files, id: 1 },
    }),
  );
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips"]);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome).toEqual({ kind: "download" });
});
