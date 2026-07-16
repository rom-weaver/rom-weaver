import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { loadLocalBundleSession } from "../../src/lib/bundle/local-bundle-session.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { loadBundleUrlSession } from "../../src/webapp/url-session/bundle-url-session.ts";
import {
  clickApplyButton,
  getOutputFileNameValue,
  getPatchStackFileNames,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const ALTERNATE_PATCH = "tests/fixtures/archive_sources/multi-patch/alternate.ips";
const BUNDLE_URL = `${location.origin}/virtual/bundle/rom-weaver-bundle.json`;

// The bundle's sources are real same-origin fixture URLs (only the rom-weaver-bundle.json itself is virtual, so
// fetch is stubbed for that one URL and passed through for everything else).
const BUNDLE_JSON = {
  output: { name: "bundle-output" },
  patches: [
    {
      description: "Required core patch",
      label: "stable",
      name: "Core",
      url: `${location.origin}/${RAW_PATCH}`,
    },
    { name: "Alternate", optional: true, url: `${location.origin}/${ALTERNATE_PATCH}` },
  ],
  rom: { url: `${location.origin}/${RAW_ROM}` },
  version: 1,
};

const withBundleFetchStub = async (bundle, run) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url === BUNDLE_URL) {
      return Promise.resolve(
        new Response(JSON.stringify(bundle), { headers: { "content-type": "application/json" }, status: 200 }),
      );
    }
    return originalFetch(input, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const getPatchToggles = () => Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .patch-enable input"));

// Pack files into a zip through the real compression runtime (what a patch
// distributor would publish as a without-ROM bundle).
const buildZip = async (entries, outputName) => {
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");
  const result = await create({
    entries,
    format: "zip",
    options: { outputName, workerThreads: 1 },
  });
  const output = result?.output;
  if (!output) throw new Error("Zip compression did not return output");
  try {
    // Materialize the bytes before dispose() deletes the backing OPFS file - a
    // File built straight from the blob references that file lazily, and reads
    // during the later drop intermittently fail once it is gone.
    const blob = await browserRuntime.publicOutput.getBlob(output);
    const bytes = await blob.arrayBuffer();
    return new File([bytes], outputName, { type: "application/zip" });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

test("local without-rom bundle drop seeds optional patches off", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const alternateFile = new File([await patchFile.arrayBuffer()], "alternate.ips", {
    type: "application/octet-stream",
  });
  const bundleJson = {
    output: { name: "bundled-output" },
    patches: [
      { name: "Core", path: "change.ips" },
      { name: "Alternate", optional: true, path: "alternate.ips" },
    ],
    rom: {
      checks: { checksums: { crc32: "d7ae93df" } },
      name: "game.bin",
    },
    version: 1,
  };
  const bundleFile = new File([JSON.stringify(bundleJson)], "rom-weaver-bundle.json", { type: "application/json" });
  const bundleArchive = await buildZip(
    [
      { file: bundleFile, fileName: "rom-weaver-bundle.json" },
      { file: patchFile, fileName: "change.ips" },
      { file: alternateFile, fileName: "alternate.ips" },
    ],
    "without-rom.zip",
  );

  // A user drop: the checks-only bundle plus their own ROM in one gesture.
  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive, romFile], id: 1 } }));

  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips", "alternate.ips"]);
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  // The optional patch must seed OFF; the core patch stays on.
  await expect.poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 }).toEqual([true, false]);
});

test("archive whose index is named rw.json (not canonical) is content-probed and seeds enablement", async () => {
  // A pre-rename bundle: its index is `rw.json`, not `rom-weaver-bundle.json`.
  // Detection must fall back to content-probing so it still auto-selects. A
  // decoy `metadata.json` that is not a bundle sits alongside to prove the
  // probe is gated on a successful parse, not on the `.json` extension.
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const alternateFile = new File([await patchFile.arrayBuffer()], "alternate.ips", {
    type: "application/octet-stream",
  });
  const legacyIndex = {
    output: { name: "bundled-output" },
    patches: [
      { name: "Core", path: "change.ips" },
      { name: "Alternate", optional: true, path: "alternate.ips" },
    ],
    rom: { checks: { checksums: { crc32: "d7ae93df" } }, name: "game.bin" },
    version: 1,
  };
  const decoy = new File([JSON.stringify({ title: "not a bundle" })], "metadata.json", { type: "application/json" });
  const indexFile = new File([JSON.stringify(legacyIndex)], "rw.json", { type: "application/json" });
  const bundleArchive = await buildZip(
    [
      { file: decoy, fileName: "metadata.json" },
      { file: indexFile, fileName: "rw.json" },
      { file: patchFile, fileName: "change.ips" },
      { file: alternateFile, fileName: "alternate.ips" },
    ],
    "legacy-rw.zip",
  );

  mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleArchive, romFile], id: 1 } }));

  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips", "alternate.ips"]);
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  await expect.poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 }).toEqual([true, false]);
});

test("local bundle remote sources remain live until the workflow owner is disposed", async () => {
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  const bundleFile = new File(
    [
      JSON.stringify({
        patches: [{ name: "Core", url: `${location.origin}/${RAW_PATCH}` }],
        rom: { url: `${location.origin}/${RAW_ROM}` },
        version: 1,
      }),
    ],
    "rom-weaver-bundle.json",
    { type: "application/json" },
  );
  try {
    mount(createElement(ApplyPatchForm, { pageDrop: { files: [bundleFile], id: 1 } }));
    await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips"]);
    await waitForApplyButtonEnabled();
    const remotePaths = truncateSpy.mock.calls
      .map(([filePath]) => filePath)
      .filter((filePath) => filePath.includes("/remote-fetch/"));
    expect(remotePaths).toHaveLength(2);
    expect(await Promise.all(remotePaths.map((filePath) => browserVfs.stat(filePath)))).not.toContain(null);

    mount(createElement("div"));
    await expect
      .poll(async () => Promise.all(remotePaths.map((filePath) => browserVfs.stat(filePath))))
      .toEqual([null, null]);
  } finally {
    truncateSpy.mockRestore();
  }
});

test("local bundle cleans acquired remote siblings when another source fails", async () => {
  const originalFetch = globalThis.fetch;
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  const missingPatchUrl = `${location.origin}/virtual/missing.ips`;
  const slowPatchUrl = `${location.origin}/virtual/slow.ips`;
  let slowPatchAborted = false;
  const bundleFile = new File(
    [
      JSON.stringify({
        patches: [
          { name: "Core", url: `${location.origin}/${RAW_PATCH}` },
          { name: "Missing", url: missingPatchUrl },
          { name: "Slow", url: slowPatchUrl },
        ],
        rom: { url: `${location.origin}/${RAW_ROM}` },
        version: 1,
      }),
    ],
    "rom-weaver-bundle.json",
    { type: "application/json" },
  );
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url === missingPatchUrl) {
      return new Promise((resolve) => setTimeout(() => resolve(new Response("missing", { status: 404 })), 25));
    }
    if (url === slowPatchUrl) {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              init?.signal?.addEventListener(
                "abort",
                () => {
                  slowPatchAborted = true;
                  controller.error(new DOMException("download aborted", "AbortError"));
                },
                { once: true },
              );
            },
          }),
        ),
      );
    }
    if (url === `${location.origin}/${RAW_ROM}` || url === `${location.origin}/${RAW_PATCH}`) {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    }
    return originalFetch(input, init);
  };
  try {
    const error = await loadLocalBundleSession(bundleFile, []).catch((reason) => reason);
    expect(error).toMatchObject({ kind: "http", status: 404 });
    expect(slowPatchAborted).toBe(true);

    const remotePaths = truncateSpy.mock.calls
      .map(([filePath]) => filePath)
      .filter((filePath) => filePath.includes("/remote-fetch/"));
    expect(remotePaths).toHaveLength(3);
    await expect
      .poll(async () => Promise.all(remotePaths.map((filePath) => browserVfs.stat(filePath))))
      .toEqual([null, null, null]);
  } finally {
    globalThis.fetch = originalFetch;
    truncateSpy.mockRestore();
  }
});

test("local bundle cancellation aborts active remote acquisition and removes its partial OPFS file", async () => {
  const originalFetch = globalThis.fetch;
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  const controller = new AbortController();
  const remoteRomUrl = `${location.origin}/virtual/never-finishes.bin`;
  let fetchStarted = false;
  const bundleFile = new File(
    [JSON.stringify({ patches: [{ path: "change.ips" }], rom: { url: remoteRomUrl }, version: 1 })],
    "rom-weaver-bundle.json",
    { type: "application/json" },
  );
  const localPatch = new File([new Uint8Array([1])], "change.ips");
  globalThis.fetch = (_input, init) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(streamController) {
            fetchStarted = true;
            streamController.enqueue(new Uint8Array([1, 2, 3]));
            init?.signal?.addEventListener(
              "abort",
              () => streamController.error(new DOMException("download aborted", "AbortError")),
              { once: true },
            );
          },
        }),
      ),
    );
  try {
    const loading = loadLocalBundleSession(bundleFile, [localPatch], { signal: controller.signal }).catch(
      (reason) => reason,
    );
    await expect.poll(() => fetchStarted, { timeout: 30000 }).toBe(true);
    controller.abort();
    const error = await loading;
    expect(error).toMatchObject({ kind: "aborted" });

    const remotePaths = truncateSpy.mock.calls
      .map(([filePath]) => filePath)
      .filter((filePath) => filePath.includes("/remote-fetch/"));
    expect(remotePaths).toHaveLength(1);
    await expect.poll(async () => browserVfs.stat(remotePaths[0])).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    truncateSpy.mockRestore();
  }
});

test("bundle url session seeds enablement + output defaults and applies to a download", async () => {
  // The REAL boot flow: fetch → wasm bundle parse → plan → source acquisition (same code the
  // use-url-session-boot hook runs).
  const { cleanup, files, session } = await withBundleFetchStub(BUNDLE_JSON, () => loadBundleUrlSession(BUNDLE_URL));
  expect(files.map((file) => file.name)).toEqual(["game.bin", "change.ips", "alternate.ips"]);
  // The display name derives from the output naming now that bundles carry no name field.
  expect(session.name).toBe("bundle-output");
  expect(session.entries.map((entry) => entry.optional)).toEqual([false, true]);
  expect(session.outputDefaults).toEqual({ name: "bundle-output" });

  // Deliver exactly like WebappRoot does: one pageDrop plus the decorated session prop.
  mount(
    createElement(ApplyPatchForm, {
      bundleSession: session,
      pageDrop: { files, id: 1 },
    }),
  );

  // Patches land in bundle order.
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips", "alternate.ips"]);
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  // Default-on patch stays toggleable.
  await expect.poll(() => getPatchToggles()[0]?.disabled, { timeout: 30000 }).toBe(false);
  expect(getPatchToggles()[0]?.checked).toBe(true);
  // Default-off patch starts Off and stays toggleable.
  await expect.poll(() => getPatchToggles()[1]?.checked, { timeout: 30000 }).toBe(false);
  expect(getPatchToggles()[1]?.disabled).toBe(false);
  getPatchToggles()[1]?.click();
  await expect.poll(() => getPatchToggles()[1]?.checked).toBe(true);
  getPatchToggles()[1]?.click();
  await expect.poll(() => getPatchToggles()[1]?.checked).toBe(false);
  // Bundle metadata reaches the patch cards; the plain view shows the bundle
  // description as static card text.
  const patchStackText = () => document.getElementById("rom-weaver-list-patch-stack")?.textContent || "";
  expect(patchStackText()).toContain("stable");
  expect(document.getElementById("rom-weaver-patch-card-description-0")?.textContent).toBe("Required core patch");
  // Bundle-edit mode (entered through the session bar's action) swaps the
  // static description for the inline editable fields on the card.
  const modeToggle = await waitForState(() => document.getElementById("rom-weaver-toggle-bundle-edit"));
  modeToggle?.click();
  const descriptionInput = await waitForState(() => document.getElementById("rom-weaver-patch-description-0"));
  expect(descriptionInput?.value).toBe("Required core patch");
  expect(descriptionInput?.tagName).toBe("TEXTAREA");
  expect(document.querySelector(".bundle-banner")).toBeNull();
  expect(document.getElementById("rom-weaver-patch-card-description-0")).toBeNull();
  // Output defaults applied once through the output controller.
  await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe("bundle-output");

  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome).toEqual({ kind: "download" });
  await cleanup();
});
