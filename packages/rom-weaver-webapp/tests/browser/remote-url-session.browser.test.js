import { createElement, useState } from "react";
import { expect, test, vi } from "vitest";
import { fetchRemoteFiles, RemoteFetchError } from "../../src/lib/remote/remote-file-fetch.ts";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { readUrlSessionRequest } from "../../src/webapp/url-session/url-session-request.ts";
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

const UrlSessionRetryHarness = ({ deliverFiles, request }) => {
  const [generation, setGeneration] = useState(0);
  const { cancel, retry, state } = useUrlSessionBoot(request, deliverFiles, undefined, {
    deliveryGeneration: generation,
    isDeliveryCurrent: (candidate) => candidate === generation,
  });
  return createElement(
    "div",
    null,
    createElement("span", { id: "url-session-phase" }, state.phase),
    createElement("button", { id: "url-session-cancel", onClick: cancel, type: "button" }, "Cancel"),
    state.phase === "error"
      ? createElement(
          "button",
          {
            id: "url-session-retry",
            onClick: () => {
              setGeneration((previous) => previous + 1);
              retry();
            },
            type: "button",
          },
          "Retry",
        )
      : null,
  );
};

const UrlSessionReplacementHarness = ({ request }) => {
  const [generation, setGeneration] = useState(0);
  const [delivered, setDelivered] = useState(0);
  const [advisory, setAdvisory] = useState("");
  useUrlSessionBoot(request, (files) => setDelivered(files.length), undefined, {
    deliveryGeneration: generation,
    isDeliveryCurrent: (candidate) => candidate === generation,
    onSessionDelivered: (warnings) => setAdvisory(warnings.join("\n")),
  });
  return createElement(
    "div",
    null,
    createElement("span", { id: "url-session-delivered" }, String(delivered)),
    createElement("span", { id: "url-session-advisory" }, advisory),
    createElement(
      "button",
      {
        id: "url-session-manual-replacement",
        onClick: () => {
          setGeneration((previous) => previous + 1);
          setAdvisory("");
        },
        type: "button",
      },
      "Manual replacement",
    ),
  );
};

const UrlSessionApplyHarness = ({ initialWarnings, request }) => {
  const [pageDrop, setPageDrop] = useState(null);
  const [sessionAdvisory, setSessionAdvisory] = useState(null);
  useUrlSessionBoot(request, (files) => setPageDrop({ files, id: 1 }), undefined, {
    initialWarnings,
    onSessionDelivered: (warnings, kind) => setSessionAdvisory({ key: `${kind}-session`, kind, warnings }),
  });
  return createElement(ApplyPatchForm, { pageDrop, sessionAdvisory });
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

test("fatal URL session fetches keep retry behavior", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  let delivered = [];
  globalThis.fetch = () => {
    attempts += 1;
    return attempts === 1
      ? Promise.resolve(new Response("missing", { status: 503 }))
      : Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
  };
  try {
    mount(
      createElement(UrlSessionRetryHarness, {
        deliverFiles: (files) => {
          delivered = files;
        },
        request: { kind: "direct", patchUrls: [], romUrl: "https://files.example/retry.bin" },
      }),
    );
    await expect.poll(() => document.getElementById("url-session-phase")?.textContent).toBe("error");
    document.getElementById("url-session-retry")?.click();
    await expect.poll(() => delivered.length).toBe(1);
    expect(attempts).toBe(2);
    expect(document.getElementById("url-session-phase")?.textContent).toBe("done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual replacement cancels pending URL delivery and advisory state", async () => {
  const originalFetch = globalThis.fetch;
  let fetchStarted = false;
  let resolveFetch;
  globalThis.fetch = (_input, init) => {
    fetchStarted = true;
    return new Promise((resolve, reject) => {
      resolveFetch = resolve;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("download aborted", "AbortError")), {
        once: true,
      });
    });
  };
  try {
    mount(
      createElement(UrlSessionReplacementHarness, {
        request: { kind: "direct", patchUrls: [], romUrl: "https://files.example/replaced.bin" },
      }),
    );
    await expect.poll(() => fetchStarted).toBe(true);
    document.getElementById("url-session-manual-replacement")?.click();
    resolveFetch?.(new Response(new Uint8Array([1, 2, 3])));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.getElementById("url-session-delivered")?.textContent).toBe("0");
    expect(document.getElementById("url-session-advisory")?.textContent).toBe("");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("warning-only direct URL parameters reach Apply after file delivery and can be dismissed", async () => {
  const parsed = readUrlSessionRequest(
    `?rom=file:///private/secret.bin&patch=${encodeURIComponent(`${location.origin}/${RAW_PATCH}`)}`,
    location.href,
  );
  expect(parsed.request?.kind).toBe("direct");
  expect(parsed.warnings).toHaveLength(1);
  mount(createElement(UrlSessionApplyHarness, { initialWarnings: parsed.warnings, request: parsed.request }));

  await expect
    .poll(() => document.getElementById("rom-weaver-row-error-message")?.textContent || "", { timeout: 30000 })
    .toContain("shared session loaded with warnings");
  const notice = document.getElementById("rom-weaver-row-error-message");
  expect(notice?.querySelector(".notice-copy")?.childNodes[0]?.textContent).toContain(
    "shared session loaded with warnings",
  );
  expect(notice?.querySelector("details pre")?.textContent).toContain("file:///private/secret.bin");
  expect(notice?.querySelector(".notice-x")?.getAttribute("aria-label")).toBe("Dismiss");
  notice?.querySelector(".notice-x")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await expect.poll(() => document.getElementById("rom-weaver-row-error-message")).toBeNull();
});

test("warning-only bundle URL parameters reach Apply after successful session delivery", async () => {
  const bundleUrl = `${location.origin}/virtual/warning-bundle.json`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url === bundleUrl) {
      return Promise.resolve(
        new Response(JSON.stringify({ patches: [{ url: `${location.origin}/${RAW_PATCH}` }], version: 1 }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    }
    return originalFetch(input, init);
  };
  try {
    mount(
      createElement(UrlSessionApplyHarness, {
        initialWarnings: ["ignored bundle member https://cdn.example/index.json?token=secret"],
        request: { bundleUrl, kind: "bundle" },
      }),
    );
    await expect
      .poll(() => document.getElementById("rom-weaver-row-error-message")?.textContent || "", { timeout: 30000 })
      .toContain("bundle loaded with warnings");
    const notice = document.getElementById("rom-weaver-row-error-message");
    expect(notice?.querySelector(".notice-copy")?.childNodes[0]?.textContent).not.toContain("token=secret");
    expect(notice?.querySelector("details pre")?.textContent).toContain("?…");
  } finally {
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

test("sample action stays in-page and flows through the drop pipeline to a green apply", async () => {
  mount(createElement(ApplyPatchForm));
  const href = location.href;
  await expect.poll(() => document.querySelector(".sample-tutorial-start-chip")).toBeInstanceOf(HTMLButtonElement);
  document.querySelector(".sample-tutorial-start-chip").click();
  await expect.poll(() => document.querySelector(".sample-tutorial-start-primary")).toBeInstanceOf(HTMLAnchorElement);
  document.querySelector(".sample-tutorial-start-primary").click();
  expect(location.href).toBe(href);

  await expect.poll(() => getInputStackRows().length, { timeout: 30000 }).toBe(1);
  await expect
    .poll(() => getPatchStackFileNames(), { timeout: 30000 })
    .toEqual(["hello-to-modified.ips", "world-to-rom.ips"]);
  await expect
    .poll(() => document.querySelectorAll('#rom-weaver-list-patch-stack button[title="Preflight passed"]').length, {
      timeout: 30000,
    })
    .toBe(1);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  expect(await waitForApplyOutcome()).toEqual({ kind: "download" });
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
