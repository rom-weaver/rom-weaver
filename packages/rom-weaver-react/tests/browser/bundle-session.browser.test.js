import { createElement } from "react";
import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
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
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], outputName, { type: "application/zip" });
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

test("bundle url session seeds enablement + output defaults and applies to a download", async () => {
  // The REAL boot flow: fetch → wasm bundle parse → plan → source acquisition (same code the
  // use-url-session-boot hook runs).
  const { files, session } = await withBundleFetchStub(BUNDLE_JSON, () => loadBundleUrlSession(BUNDLE_URL));
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
  // Bundle metadata reaches the patch cards and editable Options fields.
  const patchStackText = () => document.getElementById("rom-weaver-list-patch-stack")?.textContent || "";
  expect(patchStackText()).toContain("stable");
  document.querySelector("#rom-weaver-list-patch-stack .optsblock .cks-head")?.click();
  const descriptionInput = await waitForState(() => document.getElementById("rom-weaver-patch-description-0"));
  expect(descriptionInput?.value).toBe("Required core patch");
  expect(descriptionInput?.tagName).toBe("TEXTAREA");
  expect(document.querySelector(".bundle-banner")).toBeNull();
  expect(document.getElementById("rom-weaver-patch-card-description-0")?.textContent).toBe("Required core patch");
  // Output defaults applied once through the output controller.
  await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe("bundle-output");

  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome).toEqual({ kind: "download" });
});
