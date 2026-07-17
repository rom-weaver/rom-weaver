import { createElement } from "react";
import { expect, test, vi } from "vitest";
import { fetchRemoteFiles, RemoteFetchError } from "../../src/lib/remote/remote-file-fetch.ts";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { useUrlSessionBoot } from "../../src/webapp/url-session/use-url-session-boot.ts";
import {
  clickApplyButton,
  getInputStackRows,
  getPatchStackFileNames,
  installPatcherTestHooks,
  mount,
  RAW_PATCH,
  RAW_ROM,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const UrlSessionBootHarness = ({ deliverFiles, request }) => {
  useUrlSessionBoot(request, deliverFiles);
  return null;
};

test("url boot cleans a delivered OPFS file when no workflow adopts it", async () => {
  const originalFetch = globalThis.fetch;
  let delivered = [];
  globalThis.fetch = () => Promise.resolve(new Response(new Uint8Array([9, 8, 7])));
  try {
    mount(
      createElement(UrlSessionBootHarness, {
        deliverFiles: (files) => {
          delivered = files;
        },
        request: { kind: "direct", patchUrls: [], romUrl: "https://files.example/session.bin" },
      }),
    );
    await expect.poll(() => delivered.length).toBe(1);
    const file = delivered[0];
    const filePath = file.filePath;
    expect((await browserVfs.stat(filePath))?.size).toBe(3);
    mount(createElement("div"));
    await expect.poll(async () => browserVfs.stat(filePath)).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Apply workflow releases replaced inputs and cleared patches without waiting for dispose", async () => {
  const [firstRom] = await fetchRemoteFiles([{ url: `${location.origin}/${RAW_ROM}` }]);
  const [secondRom] = await fetchRemoteFiles([{ url: `${location.origin}/${RAW_ROM}` }]);
  const [patch] = await fetchRemoteFiles([{ url: `${location.origin}/${RAW_PATCH}` }]);
  const workflow = new ApplyWorkflow({
    settings: {
      output: { compression: "none", outputName: "patched.bin" },
      workers: { threads: 1 },
    },
  });
  let disposed = false;
  try {
    expect(new Set([firstRom.filePath, secondRom.filePath, patch.filePath])).toHaveLength(3);

    await workflow.setInput(firstRom.file);
    expect((await browserVfs.stat(firstRom.filePath))?.size).toBeGreaterThan(0);

    // Re-staging the exact same source must transfer ownership to the replacement session before
    // the old session releases it.
    await workflow.setInput(firstRom.file);
    expect((await browserVfs.stat(firstRom.filePath))?.size).toBeGreaterThan(0);

    await workflow.setInput(secondRom.file);
    await expect.poll(async () => browserVfs.stat(firstRom.filePath)).toBeNull();
    expect((await browserVfs.stat(secondRom.filePath))?.size).toBeGreaterThan(0);

    await workflow.addPatch(patch.file);
    expect((await browserVfs.stat(patch.filePath))?.size).toBeGreaterThan(0);
    await workflow.clearPatches();
    // A clear followed immediately by re-add is another ownership transfer, not final cleanup.
    await workflow.addPatch(patch.file);
    expect((await browserVfs.stat(patch.filePath))?.size).toBeGreaterThan(0);
    await workflow.clearPatches();
    await expect.poll(async () => browserVfs.stat(patch.filePath)).toBeNull();
    expect((await browserVfs.stat(secondRom.filePath))?.size).toBeGreaterThan(0);

    await workflow.dispose();
    disposed = true;
    expect(await browserVfs.stat(secondRom.filePath)).toBeNull();
  } finally {
    if (!disposed) await workflow.dispose();
    await Promise.all([firstRom.cleanup(), secondRom.cleanup(), patch.cleanup()]);
  }
});

test("url boot cancellation removes a partial OPFS download before delivery", async () => {
  const originalFetch = globalThis.fetch;
  const truncateSpy = vi.spyOn(browserVfs, "truncate");
  let fetchStarted = false;
  globalThis.fetch = (_input, init) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            fetchStarted = true;
            controller.enqueue(new Uint8Array([1, 2, 3]));
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("download aborted", "AbortError")),
              { once: true },
            );
          },
        }),
      ),
    );
  try {
    mount(
      createElement(UrlSessionBootHarness, {
        deliverFiles: () => undefined,
        request: { kind: "direct", patchUrls: [], romUrl: "https://files.example/cancel.bin" },
      }),
    );
    await expect.poll(() => fetchStarted).toBe(true);
    const filePath = truncateSpy.mock.calls.at(-1)?.[0];
    mount(createElement("div"));
    await expect.poll(async () => browserVfs.stat(filePath)).toBeNull();
  } finally {
    truncateSpy.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("remote fetch streams chunks into OPFS and final owner cleanup removes the retained file", async () => {
  const originalFetch = globalThis.fetch;
  const writeSpy = vi.spyOn(browserVfs, "write");
  const progress = [];
  let fetched;
  let staged;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4, 5]));
            controller.close();
          },
        }),
        {
          headers: {
            "content-disposition": 'attachment; filename="remote.bin"',
            "content-length": "5",
          },
        },
      ),
    );
  try {
    [fetched] = await fetchRemoteFiles([
      { onProgress: (entry) => progress.push(entry.loadedBytes), url: "https://files.example/input.bin" },
    ]);
    expect(fetched.file.name).toBe("remote.bin");
    expect(new Uint8Array(await fetched.file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect((await browserVfs.stat(fetched.filePath))?.size).toBe(5);
    expect(writeSpy.mock.calls.filter(([filePath]) => filePath === fetched.filePath)).toHaveLength(1);
    expect(progress).toEqual([2, 5]);

    staged = await browserRuntime.workerIo.stageSource({
      fallbackFileName: fetched.file.name,
      scope: "apply",
      source: fetched.file,
    });
    expect(staged.filePath).toBe(fetched.filePath);
    expect(staged.virtual).not.toBe(true);
    await staged.cleanup();
    staged = undefined;
    await browserRuntime.workerIo.releaseSources?.([fetched.file]);
    expect((await browserVfs.stat(fetched.filePath))?.size).toBe(5);
    await browserRuntime.workerIo.releaseOwnedSources?.([fetched.file]);
    expect(await browserVfs.stat(fetched.filePath)).toBeNull();
  } finally {
    await staged?.cleanup();
    await fetched?.cleanup();
    writeSpy.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("remote fetch caps coalesced OPFS writes at eight MiB", async () => {
  const originalFetch = globalThis.fetch;
  const writeSpy = vi.spyOn(browserVfs, "write");
  const writeSize = 8 * 1024 * 1024;
  let fetched;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(writeSize - 1));
            controller.enqueue(new Uint8Array([1, 2]));
            controller.close();
          },
        }),
        { headers: { "content-length": String(writeSize + 1) } },
      ),
    );
  try {
    [fetched] = await fetchRemoteFiles([{ url: "https://files.example/large.bin" }]);
    const writes = writeSpy.mock.calls.filter(([filePath]) => filePath === fetched.filePath);
    expect(writes).toHaveLength(2);
    expect(writes.map(([, bytes]) => bytes.byteLength)).toEqual([writeSize, 1]);
    expect(writes.map(([, , options]) => options?.fileOffset)).toEqual([0, writeSize]);
  } finally {
    await fetched?.cleanup();
    writeSpy.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("url-session files fetched from same-origin urls flow through the drop pipeline to a green apply", async () => {
  // Same-origin fixture URLs stand in for a distributor's CORS-enabled host.
  const fetched = await fetchRemoteFiles([
    { url: `${location.origin}/${RAW_ROM}` },
    { url: `${location.origin}/${RAW_PATCH}` },
  ]);
  expect(fetched.map((entry) => entry.file.name)).toEqual(["game.bin", "change.ips"]);

  // Deliver exactly like the WebappRoot url-session boot does: one pageDrop.
  mount(
    createElement(ApplyPatchForm, {
      pageDrop: { files: fetched.map((entry) => entry.file), id: 1 },
    }),
  );

  await expect.poll(() => getInputStackRows().length, { timeout: 30000 }).toBe(1);
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips"]);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome).toEqual({ kind: "download" });
  await Promise.all(fetched.map((entry) => entry.cleanup()));
});

test("remote fetch reports http failures and CORS-shaped blocks as coded errors", async () => {
  const originalFetch = globalThis.fetch;
  // The vitest dev server SPA-fallbacks unknown paths, so stub a real 404.
  globalThis.fetch = () => Promise.resolve(new Response("missing", { status: 404 }));
  try {
    const missing = await fetchRemoteFiles([{ url: `${location.origin}/tests/fixtures/does-not-exist.bin` }]).catch(
      (error) => error,
    );
    expect(missing).toBeInstanceOf(RemoteFetchError);
    expect(missing.kind).toBe("http");
    expect(missing.status).toBe(404);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  try {
    const blocked = await fetchRemoteFiles([{ url: "https://blocked.example/rom.bin" }]).catch((error) => error);
    expect(blocked).toBeInstanceOf(RemoteFetchError);
    expect(blocked.kind).toBe("blocked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote fetch rejects a pre-aborted request before starting network or OPFS work", async () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn(originalFetch);
  globalThis.fetch = fetchSpy;
  try {
    const controller = new AbortController();
    controller.abort();
    const error = await fetchRemoteFiles([{ url: "https://files.example/never-start.bin" }], controller.signal).catch(
      (reason) => reason,
    );
    expect(error).toBeInstanceOf(RemoteFetchError);
    expect(error.kind).toBe("aborted");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
