import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { RomWeaverError } from "../../src/lib/errors.ts";
import { loadLocalWeaveSession } from "../../src/lib/weave/local-weave-session.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { loadWeaveUrlSession } from "../../src/webapp/url-session/weave-url-session.ts";
import {
  clickApplyButton,
  getOutputFileNameValue,
  getPatchStackFileNames,
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  WRONG_INPUT_BPS,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
  waitForState,
  setFormControlValue,
} from "./patcher-test-shared.js";
import {
  getPatchToggles,
  buildZip,
  SAMPLE_ROM,
  mountStrict,
  sha256Hex,
  captureDownloads,
  hex,
  fileChecks,
  noiseBytes,
  withBytes,
  createBps,
  createIps,
  applyRecords,
  SNES_INTERNAL_HEADER,
  byteSwap16,
  applyWeaveAndReadOutput,
  buildWeaveArchive,
  expectStrictApply,
  ipsFile,
  buildSampleWeave,
  loadWrongSampleRom,
  getChecksumOverride,
  IPS_EOF,
  IPS_HEADER,
} from "./weave-session-shared.js";

installPatcherTestHooks();

// A transient failure hashing a declared algorithm leaves the patches retryable: Apply hashes again
// and, once that works, applies the matching ROM without the override.
test("a transient weave-ROM hash failure recovers on Apply", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", await romFile.arrayBuffer())));
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "retry-output" },
      patchBasis: "auto",
      patches: [{ name: "Core", path: patchFile.name }],
      rom: { checks: { checksums: { sha256 } }, name: "game.bin" },
      version: 2,
    },
    [patchFile],
  );
  const original = browserRuntime.ingest.run;
  let failed = false;
  const ingestSpy = vi.spyOn(browserRuntime.ingest, "run").mockImplementation(async (input) => {
    if (!failed && input.checksumAlgorithms?.join(",") === "sha256") {
      failed = true;
      throw new RomWeaverError("WORKER_FAILED", "The checksum worker stopped");
    }
    return original.call(browserRuntime.ingest, input);
  });
  try {
    await expectStrictApply([weaveArchive, romFile], { outputName: "retry-output", romMatches: true });
    expect(failed).toBe(true);
    expect(ingestSpy.mock.calls.filter(([input]) => input.checksumAlgorithms?.join(",") === "sha256").length).toBe(2);
  } finally {
    ingestSpy.mockRestore();
  }
});

// Dropping another ROM while a validation pass hashes the old one cancels that hash, so the new ROM
// stages without waiting for it and the old ROM is not hashed again.
test("replacing the ROM in the form cancels the old ROM's weave hash", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "replace-output" },
      patchBasis: "auto",
      patches: [{ name: "Core", path: patchFile.name }],
      rom: { checks: { checksums: { sha256: "ab".repeat(32) } }, name: "game.bin" },
      version: 2,
    },
    [patchFile],
  );
  const otherBytes = new Uint8Array(await romFile.arrayBuffer());
  otherBytes[0] ^= 0xff;
  const otherRom = new File([otherBytes], "other-rom.bin", { type: "application/octet-stream" });
  const original = browserRuntime.ingest.run;
  const calls = [];
  let heldSignal;
  let releaseHeld;
  // Hold the first on-demand SHA-256 hash until it is cancelled (or the test ends).
  const ingestSpy = vi.spyOn(browserRuntime.ingest, "run").mockImplementation((input) => {
    calls.push({ algorithms: (input.checksumAlgorithms || []).join(","), fileName: input.fileName });
    if (input.checksumAlgorithms?.join(",") !== "sha256" || heldSignal)
      return original.call(browserRuntime.ingest, input);
    heldSignal = input.signal;
    return new Promise((_, reject) => {
      releaseHeld = () => reject(new RomWeaverError("WORKER_FAILED", "released by the test"));
      input.signal?.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    });
  });
  try {
    const props = { defaultSettings: { validation: { requireInputChecksumMatch: true } } };
    const root = mount(
      createElement(ApplyPatchForm, { ...props, pageDrop: { files: [weaveArchive, romFile], id: 1 } }),
    );
    await waitForState(() => heldSignal, 60000);
    root.render(
      createElement(
        RomWeaverSettingsProvider,
        { settings: { detailedViewEnabled: true } },
        createElement(ApplyPatchForm, { ...props, pageDrop: { files: [otherRom], id: 2 } }),
      ),
    );
    await expect.poll(() => heldSignal.aborted, { timeout: 10000 }).toBe(true);
    await expect.poll(() => calls.some((call) => call.fileName === "other-rom.bin"), { timeout: 30000 }).toBe(true);
    expect(calls.filter((call) => call.fileName === "game.bin" && call.algorithms === "sha256")).toHaveLength(1);
  } finally {
    releaseHeld?.();
    ingestSpy.mockRestore();
  }
});

// A patch the engine fails reports its own error even when the weave's ROM also mismatches, so the
// user sees it before checking the override.
test("a failing patch keeps its own error under a weave ROM mismatch", async () => {
  const [romFile, wrongPatch] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(WRONG_INPUT_BPS)]);
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "failing-output" },
      patchBasis: "auto",
      patches: [{ name: "Wrong", path: "wrong-input.bps" }],
      rom: { checks: { checksums: { crc32: "a1cecd74" } }, name: "game.bin" },
      version: 2,
    },
    [new File([await wrongPatch.arrayBuffer()], "wrong-input.bps")],
  );
  mountStrict([weaveArchive, romFile]);
  const detail = () => document.querySelector("#rom-weaver-list-patch-stack .pfault-detail")?.textContent || "";
  await expect.poll(detail, { timeout: 60000 }).not.toBe("");
  expect(detail()).not.toContain("a1cecd74");
});

test("archive whose index is named rw.json (not canonical) is content-probed and seeds enablement", async () => {
  // A pre-rename weave: its index is `rw.json`, not `rom-weaver-weave.json`.
  // Detection must fall back to content-probing so it still auto-selects. A
  // decoy `metadata.json` that is not a weave sits alongside to prove the
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
    rom: { checks: { checksums: { crc32: "c6fb1252" } }, name: "game.bin" },
    version: 1,
  };
  const decoy = new File([JSON.stringify({ title: "not a weave" })], "metadata.json", { type: "application/json" });
  const indexFile = new File([JSON.stringify(legacyIndex)], "rw.json", { type: "application/json" });
  const weaveArchive = await buildZip(
    [
      { file: decoy, fileName: "metadata.json" },
      { file: indexFile, fileName: "rw.json" },
      { file: patchFile, fileName: "change.ips" },
      { file: alternateFile, fileName: "alternate.ips" },
    ],
    "legacy-rw.zip",
  );

  mount(createElement(ApplyPatchForm, { pageDrop: { files: [weaveArchive, romFile], id: 1 } }));

  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips", "alternate.ips"]);
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  await expect.poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 }).toEqual([true, false]);
});

test("local v2 weave keeps a per-patch input override", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const weaveFile = new File(
    [
      JSON.stringify({
        patchBasis: "base",
        patches: [{ basis: "previous", path: patchFile.name }],
        rom: { path: romFile.name },
        version: 2,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );

  const loaded = await loadLocalWeaveSession(weaveFile, [romFile, patchFile]);
  try {
    expect(loaded.session.patchBasis).toBe("base");
    expect(loaded.session.entries[0]?.basis).toBe("previous");
  } finally {
    await loaded.cleanup();
  }
});

test("local weave remote sources remain live until the workflow owner is disposed", async () => {
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  const weaveFile = new File(
    [
      JSON.stringify({
        patches: [{ name: "Core", url: `${location.origin}/${RAW_PATCH}` }],
        rom: { url: `${location.origin}/${RAW_ROM}` },
        version: 1,
      }),
    ],
    "rom-weaver-weave.json",
    { type: "application/json" },
  );
  try {
    mount(createElement(ApplyPatchForm, { pageDrop: { files: [weaveFile], id: 1 } }));
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

test("local weave cleans acquired remote siblings when another source fails", async () => {
  const originalFetch = globalThis.fetch;
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  const missingPatchUrl = `${location.origin}/virtual/missing.ips`;
  const slowPatchUrl = `${location.origin}/virtual/slow.ips`;
  let slowPatchAborted = false;
  const weaveFile = new File(
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
    "rom-weaver-weave.json",
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
    const error = await loadLocalWeaveSession(weaveFile, []).catch((reason) => reason);
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

test("local weave cancellation aborts active remote acquisition and removes its partial OPFS file", async () => {
  const originalFetch = globalThis.fetch;
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  const controller = new AbortController();
  const remoteRomUrl = `${location.origin}/virtual/never-finishes.bin`;
  let fetchStarted = false;
  const weaveFile = new File(
    [JSON.stringify({ patches: [{ path: "change.ips" }], rom: { url: remoteRomUrl }, version: 1 })],
    "rom-weaver-weave.json",
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
    const loading = loadLocalWeaveSession(weaveFile, [localPatch], { signal: controller.signal }).catch(
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

const ALTERNATE_PATCH = "tests/fixtures/archive_sources/multi-patch/alternate.ips";

const WEAVE_URL = `${location.origin}/virtual/weave/rom-weaver-weave.json`;

// The weave's sources are real same-origin fixture URLs (only the rom-weaver-weave.json itself is virtual, so
// fetch is stubbed for that one URL and passed through for everything else).
const WEAVE_JSON = {
  output: { name: "weave-output" },
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

const withWeaveFetchStub = async (weave, run) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url === WEAVE_URL) {
      return Promise.resolve(
        new Response(JSON.stringify(weave), { headers: { "content-type": "application/json" }, status: 200 }),
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

test("weave url session seeds enablement + output defaults and applies to a download", async () => {
  // The REAL boot flow: fetch → wasm weave parse → plan → source acquisition (same code the
  // use-url-session-boot hook runs).
  const { cleanup, files, session } = await withWeaveFetchStub(WEAVE_JSON, () => loadWeaveUrlSession(WEAVE_URL));
  expect(files.map((file) => file.name)).toEqual(["game.bin", "change.ips", "alternate.ips"]);
  // The display name derives from the output naming now that weaves carry no name field.
  expect(session.name).toBe("weave-output");
  expect(session.entries.map((entry) => entry.optional)).toEqual([false, true]);
  expect(session.outputDefaults).toEqual({ name: "weave-output" });

  // Deliver exactly like WebappRoot does: one pageDrop plus the decorated session prop.
  mount(
    createElement(ApplyPatchForm, {
      weaveSession: session,
      pageDrop: { files, id: 1 },
    }),
  );

  // Patches land in weave order.
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
  // Weave metadata reaches the patch cards; the plain view shows the weave
  // description as static card text.
  const patchStackText = () => document.getElementById("rom-weaver-list-patch-stack")?.textContent || "";
  expect(patchStackText()).toContain("stable");
  expect(document.getElementById("rom-weaver-patch-card-description-0")?.textContent).toBe("Required core patch");
  // The pencil on the patch card swaps the static description for the inline
  // editable fields.
  document.getElementById("rom-weaver-patch-meta-edit-0")?.click();
  const descriptionInput = await waitForState(() => document.getElementById("rom-weaver-patch-description-0"));
  expect(descriptionInput?.value).toBe("Required core patch");
  expect(descriptionInput?.tagName).toBe("TEXTAREA");
  expect(document.querySelector(".weave-banner")).toBeNull();
  expect(document.getElementById("rom-weaver-patch-card-description-0")).toBeNull();
  // Output defaults applied once through the output controller.
  await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe("weave-output");

  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome).toEqual({ kind: "download" });
  await cleanup();
});

test("a rom extracted from the weave archive shows the weave -> rom extract chain", async () => {
  // A ROM shipped inside the weave archive is pulled out out-of-band by the weave parse, so it reaches
  // the ROM card as a bare file. It must still render the same "Extract" section (weave archive -> rom)
  // a ROM dropped inside a plain archive shows, rather than appearing as a chainless input.
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  const romInWeave = new File([await romFile.arrayBuffer()], "game.bin", { type: "application/octet-stream" });
  const weaveJson = {
    output: { name: "bundled-output" },
    patches: [{ name: "Core", path: "change.ips" }],
    rom: { path: "game.bin" },
    version: 1,
  };
  const weaveFile = new File([JSON.stringify(weaveJson)], "rom-weaver-weave.json", { type: "application/json" });
  const weaveArchive = await buildZip(
    [
      { file: weaveFile, fileName: "rom-weaver-weave.json" },
      { file: romInWeave, fileName: "game.bin" },
      { file: patchFile, fileName: "change.ips" },
    ],
    "with-rom.zip",
  );

  mount(createElement(ApplyPatchForm, { pageDrop: { files: [weaveArchive], id: 1 } }));

  const extractTreeNames = (listId) => () => {
    const drawer = document.querySelector(`#${listId} .card.file .extract-d`);
    if (!drawer) return null;
    return Array.from(drawer.querySelectorAll(".tree-name")).map((node) => node.textContent || "");
  };
  // The ROM extracted from the weave archive shows the full weave -> rom chain.
  await expect
    .poll(extractTreeNames("rom-weaver-list-input-stack"), { timeout: 30000 })
    .toEqual(expect.arrayContaining([expect.stringContaining("with-rom.zip"), expect.stringContaining("game.bin")]));
  // A patch extracted from the same weave archive keeps the parent breadcrumb, not just its bare leaf.
  await expect
    .poll(extractTreeNames("rom-weaver-list-patch-stack"), { timeout: 30000 })
    .toEqual(expect.arrayContaining([expect.stringContaining("with-rom.zip"), expect.stringContaining("change.ips")]));
});

test.each([
  ["snes", "previous", "ips"],
  ["n64", "previous", "ips"],
  ["snes", "auto", "ips"],
  ["n64", "auto", "ips"],
  ["snes", "default previous", "ips"],
  ["n64", "default previous", "ips"],
  ["snes", "auto", "bps"],
  ["n64", "auto", "bps"],
])("%s %s-basis %s chains preserve the weave layout", async (platform, basis, format) => {
  const body =
    platform === "snes"
      ? withBytes(noiseBytes(1024 * 1024, 0x5eed), 0x7fc0, SNES_INTERNAL_HEADER)
      : withBytes(noiseBytes(1024 * 1024, 0x64), 0, [0x80, 0x37, 0x12, 0x40]);
  const supplied = platform === "snes" ? new Uint8Array(512 + body.length) : byteSwap16(body);
  if (platform === "snes") supplied.set(body, 512);
  const romName = platform === "snes" ? "game.smc" : "game.v64";
  const firstRecords = [
    [0x100, 0xf2],
    [0x8000, 0x09],
    [0x9001, 0x7e],
    [0xffff0, 0x78],
  ];
  const secondRecords = [[0x8001, 0x0f]];
  const afterFirst = applyRecords(body, firstRecords);
  const afterSecond = applyRecords(afterFirst, secondRecords);
  const patches = [
    new File([createIps(firstRecords)], "first.ips"),
    new File([format === "bps" ? createBps(afterFirst, afterSecond) : createIps(secondRecords)], `second.${format}`),
  ];
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "transform-output" },
      ...(basis === "default previous" ? { patchBasis: "previous" } : {}),
      patches: [
        { path: patches[0].name, outputChecks: await fileChecks(afterFirst) },
        {
          path: patches[1].name,
          ...(basis === "previous" ? { basis } : {}),
          ...(format === "ips" ? { inputChecks: await fileChecks(afterFirst) } : {}),
          outputChecks: await fileChecks(afterSecond),
        },
      ],
      rom: { checks: await fileChecks(body), name: romName },
      version: basis === "default previous" ? 2 : 1,
    },
    patches,
  );
  const originalValidate = browserRuntime.patch.validatePatch;
  const calls = [];
  const validateSpy = vi.spyOn(browserRuntime.patch, "validatePatch").mockImplementation(async (input) => {
    const started = performance.now();
    try {
      return await originalValidate.call(browserRuntime.patch, input);
    } finally {
      calls.push({
        elapsedMs: performance.now() - started,
        removeHeader: input.options.removeHeader,
        n64ByteOrder: input.options.n64ByteOrder,
      });
    }
  });
  try {
    const { output } = await applyWeaveAndReadOutput([weaveArchive, new File([supplied], romName)]);
    const normalized = platform === "n64" && output[0] === 0x37 && output[1] === 0x80 ? byteSwap16(output) : output;
    expect(hex(normalized)).toBe(hex(afterSecond));
  } finally {
    console.log("LAYOUT_PLANNER_COST", JSON.stringify({ platform, basis, format, calls }));
    validateSpy.mockRestore();
  }
});

test("a wrong declared output check on a byte-swapped N64 weave is still rejected", async () => {
  const body = withBytes(noiseBytes(1024 * 1024, 0x64), 0, [0x80, 0x37, 0x12, 0x40]);
  const records = [[0x100, 0xf2]];
  const patches = [new File([createIps(records)], "first.ips")];
  const wrong = await fileChecks(applyRecords(body, [[0x100, 0xf3]]));
  const weaveArchive = await buildWeaveArchive(
    {
      output: { name: "transform-output" },
      patches: [{ path: patches[0].name, outputChecks: wrong }],
      rom: { checks: await fileChecks(body), name: "game.v64" },
      version: 1,
    },
    patches,
  );
  mountStrict([weaveArchive, new File([byteSwap16(body)], "game.v64")]);
  await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("transform-output");
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome?.kind).toBe("error");
  expect(outcome?.errorText).toContain("checksum mismatch");
});

test("auto basis keeps an independent embedded raw BPS source", async () => {
  const headered = new Uint8Array(await (await loadFixtureFile(SAMPLE_ROM)).arrayBuffer());
  const first = withBytes(headered, 0xa8, [0x12]);
  const later = withBytes(headered, 0xa9, [0x0f]);
  const patches = [
    new File([createBps(headered, first)], "first.bps"),
    new File([createBps(headered, later)], "later.bps"),
  ];
  const weaveArchive = await buildWeaveArchive(
    {
      version: 1,
      output: { name: "transform-output" },
      rom: { checks: await fileChecks(headered.subarray(16)), name: "hello-world.nes" },
      patches: patches.map((patch) => ({ path: patch.name })),
    },
    patches,
  );
  const { output } = await applyWeaveAndReadOutput([weaveArchive, new File([headered], "hello-world.nes")]);
  expect(hex(output)).toBe(hex(withBytes(first, 0xa9, [0x0f])));
});

test("a malformed weave drop shows an on-page error instead of silently emptying the page", async () => {
  const patchFile = await loadFixtureFile(RAW_PATCH);
  const cases = [
    { label: "bad JSON", json: "{ not json,,", entries: [] },
    {
      label: "unsupported version",
      json: JSON.stringify({ patches: [{ path: "change.ips" }], version: 3 }),
      entries: [{ file: patchFile, fileName: "change.ips" }],
    },
    {
      label: "missing patch file",
      json: JSON.stringify({ patches: [{ path: "absent.ips" }], version: 1 }),
      entries: [],
    },
  ];
  for (const [index, { label, json, entries }] of cases.entries()) {
    const weaveFile = new File([json], "rom-weaver-weave.json", { type: "application/json" });
    const archive = await buildZip(
      [{ file: weaveFile, fileName: "rom-weaver-weave.json" }, ...entries],
      `malformed-${index}.zip`,
    );
    mount(createElement(ApplyPatchForm, { pageDrop: { files: [archive], id: 1 } }));
    await expect
      .poll(() => document.querySelector("#rom-weaver-container .notice.error")?.textContent || "", {
        message: label,
        timeout: 30000,
      })
      .not.toBe("");
    expect(getPatchStackFileNames()).toEqual([]);
  }
});

// Woven output of the two sample patches (scripts/first-sample-assets.mjs `wovenRom`).
const SAMPLE_WOVEN_SHA256 = "7ac8001dcbcbff45cd5cebb5b0655192021fbbdf27533aa961347194ab3e836e";

const applyDottedSampleWeave = async ({
  compression,
  typedName,
  weaveOutputName = "Practice 3.5.1.nes",
  expectedFieldName = "Practice 3.5.1",
}) => {
  const capture = captureDownloads();
  try {
    const [weaveArchive, romFile] = await Promise.all([
      buildSampleWeave({ outputName: weaveOutputName }),
      loadFixtureFile(SAMPLE_ROM),
    ]);
    mount(
      createElement(ApplyPatchForm, {
        defaultSettings: { output: { compression } },
        pageDrop: { files: [weaveArchive, romFile], id: 1 },
      }),
    );
    // The name field carries the stem; the manifest's `.nes` belongs to the format.
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe(expectedFieldName);
    if (typedName) setFormControlValue(document.getElementById("rom-weaver-input-output-file-name"), typedName);
    await waitForApplyButtonEnabled();
    await clickApplyButton();
    const outcome = await waitForApplyOutcome();
    expect(outcome?.kind, outcome && "errorText" in outcome ? outcome.errorText : "").toBe("download");
    await expect.poll(() => capture.getDownloads().length, { timeout: 30000 }).toBeGreaterThan(0);
    return capture.getDownloads().at(-1);
  } finally {
    capture.restore();
  }
};

test("weave output name with a literal # keeps its whole stem and .nes extension", async () => {
  const download = await applyDottedSampleWeave({
    compression: "none",
    expectedFieldName: "Hack.v2#2",
    weaveOutputName: "Hack.v2#2.nes",
  });
  expect(download?.name).toBe("Hack.v2#2.nes");
  expect(await sha256Hex(download.blob)).toBe(SAMPLE_WOVEN_SHA256);
});

test("weave output name with a dotted version stem keeps its .nes extension", async () => {
  const download = await applyDottedSampleWeave({ compression: "none" });
  expect(download?.name).toBe("Practice 3.5.1.nes");
  expect(await sha256Hex(download.blob)).toBe(SAMPLE_WOVEN_SHA256);
});

test("compressed weave output with a dotted version stem names the archive entry with .nes", async () => {
  const download = await applyDottedSampleWeave({ compression: "zip" });
  expect(download?.name).toBe("Practice 3.5.1.zip");
  // A ZIP stores entry names as plain bytes in its headers.
  expect(new TextDecoder("latin1").decode(await download.blob.arrayBuffer())).toContain("Practice 3.5.1.nes");
});

for (const [typedName, expectedName] of [
  ["Typed 2.0", "Typed 2.0.nes"],
  ["Typed.nes", "Typed.nes"],
  ["Typed.sfc", "Typed.sfc"],
  ["Kaizo Mario #2.nes", "Kaizo Mario #2.nes"],
]) {
  test(`typed name "${typedName}" overrides the weave output name`, async () => {
    const download = await applyDottedSampleWeave({ compression: "none", typedName });
    expect(download?.name).toBe(expectedName);
    expect(await sha256Hex(download.blob)).toBe(SAMPLE_WOVEN_SHA256);
  });
}

for (const romKind of ["matching", "wrong"]) {
  test(`expected-ROM checks follow an optional first patch switched on (${romKind} ROM)`, async () => {
    const [weaveArchive, romFile] = await Promise.all([
      buildSampleWeave({
        patches: [
          { name: "Hello to ROM", optional: true, path: "hello-to-rom.ips" },
          { name: "World to WEAVER", path: "world-to-weaver.ips" },
        ],
      }),
      romKind === "matching" ? loadFixtureFile(SAMPLE_ROM) : loadWrongSampleRom(),
    ]);
    const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
    try {
      mountStrict([weaveArchive, romFile]);
      await expect
        .poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 })
        .toEqual([false, true]);
      await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("rom-weaver");
      getPatchToggles()[0]?.click();
      await expect
        .poll(() => getPatchToggles().map((toggle) => toggle.checked), { timeout: 30000 })
        .toEqual([true, true]);
      if (romKind === "wrong") {
        const override = await waitForState(getChecksumOverride, 60000);
        expect(applySpy).not.toHaveBeenCalled();
        override.click();
      }
      await waitForApplyButtonEnabled();
      if (romKind === "matching") expect(getChecksumOverride()).toBeNull();
      await clickApplyButton();
      expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
      const options = applySpy.mock.calls.at(-1)?.[0]?.options;
      expect(options?.patchInputChecks).toBeUndefined();
      expect(options?.validateWithChecksums).toBeUndefined();
    } finally {
      applySpy.mockRestore();
    }
  });
}

test("expected-ROM checks follow a reordered sample weave", async () => {
  const [weaveArchive, romFile] = await Promise.all([buildSampleWeave(), loadFixtureFile(SAMPLE_ROM)]);
  const applySpy = vi.spyOn(browserRuntime.patch, "applyPatch");
  try {
    mountStrict([weaveArchive, romFile]);
    await expect
      .poll(() => getPatchStackFileNames(), { timeout: 30000 })
      .toEqual(["hello-to-rom.ips", "world-to-weaver.ips"]);
    await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("rom-weaver");
    document.querySelector("#rom-weaver-list-patch-stack .handle")?.click();
    const positionInput = await waitForState(
      () => document.querySelector("#rom-weaver-list-patch-stack .phandle-input"),
      30000,
    );
    setFormControlValue(positionInput, "2");
    positionInput.blur();
    await expect
      .poll(() => getPatchStackFileNames(), { timeout: 30000 })
      .toEqual(["world-to-weaver.ips", "hello-to-rom.ips"]);
    await waitForApplyButtonEnabled();
    expect(getChecksumOverride()).toBeNull();
    await clickApplyButton();
    expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
    const options = applySpy.mock.calls.at(-1)?.[0]?.options;
    expect(options?.validateWithChecksums).toBeUndefined();
    expect(options?.validateWithOutputChecksums).toBeUndefined();
    expect(options?.patchInputChecks).toBeUndefined();
  } finally {
    applySpy.mockRestore();
  }
});

// The weave's rom.checks follow the bench like its output checks: once the patch list diverges
// from the weave they stand down, and they apply again when it matches the weave.
const movePatchToPosition = async (position) => {
  document.querySelector("#rom-weaver-list-patch-stack .handle")?.click();
  const positionInput = await waitForState(
    () => document.querySelector("#rom-weaver-list-patch-stack .phandle-input"),
    30000,
  );
  setFormControlValue(positionInput, String(position));
  positionInput.blur();
};

test("a bench that diverges from the weave drops the weave's ROM checks", async () => {
  const [weaveArchive, wrongRom] = await Promise.all([buildSampleWeave(), loadWrongSampleRom()]);
  const ownPatch = ipsFile("own-hack.ips", [...IPS_HEADER, 0, 0x30, 0, 0, 1, 0x42, ...IPS_EOF]);
  const props = { defaultSettings: { validation: { requireInputChecksumMatch: true } } };
  const root = mount(createElement(ApplyPatchForm, { ...props, pageDrop: { files: [weaveArchive, wrongRom], id: 1 } }));
  await waitForState(getChecksumOverride, 60000);
  await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("rom-weaver");
  root.render(
    createElement(
      RomWeaverSettingsProvider,
      { settings: { detailedViewEnabled: true } },
      createElement(ApplyPatchForm, { ...props, pageDrop: { files: [ownPatch], id: 2 } }),
    ),
  );
  await expect
    .poll(() => getPatchStackFileNames(), { timeout: 30000 })
    .toEqual(["hello-to-rom.ips", "world-to-weaver.ips", "own-hack.ips"]);
  for (const name of ["hello-to-rom.ips", "world-to-weaver.ips"]) {
    const index = getPatchStackFileNames().indexOf(name);
    const remove = document.querySelectorAll("button[id^='rom-weaver-patch-menu-remove-']")[index];
    if (!(remove instanceof HTMLButtonElement)) throw new Error(`Missing remove button for ${name}`);
    remove.click();
    await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).not.toContain(name);
  }
  expect(getPatchStackFileNames()).toEqual(["own-hack.ips"]);
  await waitForApplyButtonEnabled();
  expect(getChecksumOverride()).toBeNull();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
});

// Mount a strict form, then drop `files` onto the bench it already holds.
const dropOntoBench = (root, files) =>
  root.render(
    createElement(
      RomWeaverSettingsProvider,
      { settings: { detailedViewEnabled: true } },
      createElement(ApplyPatchForm, {
        defaultSettings: { validation: { requireInputChecksumMatch: true } },
        pageDrop: { files, id: 2 },
      }),
    ),
  );

test("a weave dropped onto a bench that already holds a patch does not enforce its ROM checks", async () => {
  const [weaveArchive, wrongRom] = await Promise.all([buildSampleWeave(), loadWrongSampleRom()]);
  const ownPatch = ipsFile("own-hack.ips", [...IPS_HEADER, 0, 0x30, 0, 0, 1, 0x42, ...IPS_EOF]);
  const root = mount(
    createElement(ApplyPatchForm, {
      defaultSettings: { validation: { requireInputChecksumMatch: true } },
      pageDrop: { files: [ownPatch], id: 1 },
    }),
  );
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["own-hack.ips"]);
  dropOntoBench(root, [weaveArchive, wrongRom]);
  await expect
    .poll(() => getPatchStackFileNames(), { timeout: 30000 })
    .toEqual(["own-hack.ips", "hello-to-rom.ips", "world-to-weaver.ips"]);
  // Every patch, the user's own included, validates on its own terms.
  await expect
    .poll(() => document.querySelectorAll("#rom-weaver-list-patch-stack .file.ok").length, { timeout: 60000 })
    .toBe(3);
  expect(getChecksumOverride()).toBeNull();
  expect(document.querySelector("#rom-weaver-list-patch-stack .pfault-detail")).toBeNull();
});

test("a diverged bench does not attribute the expected ROM to the weave", async () => {
  const [weaveArchive, ownBps] = await Promise.all([buildSampleWeave(), loadFixtureFile(WRONG_INPUT_BPS)]);
  const root = mount(createElement(ApplyPatchForm, { pageDrop: { files: [ownBps], id: 1 } }));
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toHaveLength(1);
  dropOntoBench(root, [weaveArchive]);
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toHaveLength(3);
  // The card still shows the first patch's input checks, attributed to that patch.
  const card = await waitForState(() => document.getElementById("rom-weaver-weave-rom-expectation"), 30000);
  await expect.poll(() => card.textContent, { timeout: 30000 }).not.toContain("provide it yourself");
  expect(card.textContent).not.toContain("hello-world.nes");
});

test("the weave's ROM checks apply again when the bench matches the weave", async () => {
  const [weaveArchive, wrongRom] = await Promise.all([buildSampleWeave(), loadWrongSampleRom()]);
  mountStrict([weaveArchive, wrongRom]);
  await waitForState(getChecksumOverride, 60000);
  await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toContain("rom-weaver");
  await movePatchToPosition(2);
  await expect
    .poll(() => getPatchStackFileNames(), { timeout: 30000 })
    .toEqual(["world-to-weaver.ips", "hello-to-rom.ips"]);
  await expect.poll(getChecksumOverride, { timeout: 30000 }).toBeNull();
  await waitForApplyButtonEnabled();
  await movePatchToPosition(2);
  await expect
    .poll(() => getPatchStackFileNames(), { timeout: 30000 })
    .toEqual(["hello-to-rom.ips", "world-to-weaver.ips"]);
  await expect.poll(getChecksumOverride, { timeout: 30000 }).not.toBeNull();
});
