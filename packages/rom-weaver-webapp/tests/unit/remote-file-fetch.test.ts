import { afterEach, describe, expect, it, vi } from "vitest";

const { vfs } = vi.hoisted(() => ({
  vfs: {
    getFile: vi.fn(),
    remove: vi.fn(async () => undefined),
    rootPath: "/work",
    truncate: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
  },
}));

vi.mock("../../src/platform/browser/workflow-runtime-vfs-cleanup.ts", () => ({ browserVfs: vfs }));

import { fetchRemoteFiles, RemoteFetchError } from "../../src/lib/remote/remote-file-fetch.ts";

const responseFor = (body: BodyInit | null, headers: Record<string, string> = {}, init: ResponseInit = {}) =>
  new Response(body, { headers, status: 200, ...init });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vfs.getFile.mockReset();
  vfs.remove.mockReset().mockResolvedValue(undefined);
  vfs.truncate.mockReset().mockResolvedValue(undefined);
  vfs.write.mockReset().mockResolvedValue(undefined);
});

describe("fetchRemoteFiles", () => {
  it("streams a response into OPFS, reports progress, and exposes a named file", async () => {
    const progress: Array<{ loadedBytes: number; totalBytes: number | null }> = [];
    const stored = new File(["hello world"], "stored.bin", { type: "application/octet-stream" });
    vfs.getFile.mockResolvedValue(stored);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFor(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("hello"));
              controller.enqueue(new TextEncoder().encode(" world"));
              controller.close();
            },
          }),
          {
            "content-disposition": "attachment; filename*=UTF-8''game%20copy.bin",
            "content-length": "11",
            "content-type": "application/custom",
          },
          { url: "https://cdn.example/final/path" },
        ),
      ),
    );

    const [download] = await fetchRemoteFiles([
      { onProgress: (event) => progress.push(event), url: "https://cdn.example/original" },
    ]);

    expect(download).toBeDefined();
    expect(download?.file.name).toBe("game copy.bin");
    expect(download?.file.type).toBe("application/custom");
    expect(download?.finalUrl).toBe("https://cdn.example/original");
    expect(download?.filePath).toMatch(/^\/work\/remote-fetch\/.+\.bin$/);
    expect(progress).toEqual([
      { loadedBytes: 5, totalBytes: 11 },
      { loadedBytes: 11, totalBytes: 11 },
    ]);
    expect(vfs.truncate).toHaveBeenCalledWith(download?.filePath, 0);
    expect(vfs.write).toHaveBeenCalledTimes(1);
    expect(vfs.write.mock.calls[0]?.[1]).toEqual(new TextEncoder().encode("hello world"));

    await download?.cleanup();
    expect(vfs.remove).toHaveBeenCalledWith(download?.filePath);
  });

  it("uses the URL tail and fallback name and supports responses without a body", async () => {
    const stored = new File(["bytes"], "stored.bin", { type: "application/octet-stream" });
    vfs.getFile.mockResolvedValue(stored);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFor(
          null,
          { "content-type": "application/octet-stream" },
          { url: "https://host/files/my%20rom.bin?x=1" },
        ),
      ),
    );
    const [fromUrl] = await fetchRemoteFiles([{ url: "https://host/files/my%20rom.bin?x=1" }]);
    expect(fromUrl?.file.name).toBe("my rom.bin");

    vfs.getFile.mockResolvedValue(stored);
    vi.mocked(fetch).mockResolvedValueOnce(responseFor(null, { "content-length": "5" }, { url: "https://host/" }));
    const [fromFallback] = await fetchRemoteFiles([{ fallbackFileName: "fallback.rom", url: "https://host/" }]);
    expect(fromFallback?.file.name).toBe("fallback.rom");
  });

  it("sanitizes unsafe content-disposition file names", async () => {
    vfs.getFile.mockResolvedValue(new File(["x"], "stored.bin"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor(new Uint8Array([120]), { "content-disposition": 'filename="a/b\\c.bin"' })),
    );
    const [download] = await fetchRemoteFiles([{ url: "https://host/download" }]);
    expect(download?.file.name).toBe("a-b-c.bin");
  });

  it("rejects an invalid HTTP response as a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor(null, {}, { status: 503, statusText: "Unavailable" })),
    );
    await expect(fetchRemoteFiles([{ url: "https://host/down" }])).rejects.toMatchObject({
      kind: "http",
      status: 503,
      url: "https://host/down",
    });
  });

  it("turns a network failure into blocked and an aborted request into aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("cors");
      }),
    );
    await expect(fetchRemoteFiles([{ url: "https://host/down" }])).rejects.toMatchObject({ kind: "blocked" });

    const signalController = new AbortController();
    signalController.abort();
    await expect(fetchRemoteFiles([{ url: "https://host/down" }], signalController.signal)).rejects.toMatchObject({
      kind: "aborted",
      url: "https://host/down",
    });
  });

  it("rejects declared oversize downloads before writing and cancels their body", async () => {
    const oversized = {
      body: { cancel: vi.fn(() => Promise.resolve()) },
      headers: new Headers({ "content-length": "4294967297" }),
      ok: true,
      status: 200,
      url: "https://host/down",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => oversized),
    );
    const error = await fetchRemoteFiles([{ url: "https://host/down" }]).catch((reason) => reason);
    expect(error).toBeInstanceOf(RemoteFetchError);
    expect(error).toMatchObject({ kind: "too-large", url: "https://host/down" });
    expect(oversized.body.cancel).toHaveBeenCalledTimes(1);
    expect(vfs.truncate).not.toHaveBeenCalled();
  });

  it("cancels and removes a partially written stream that exceeds the limit", async () => {
    const cancel = vi.fn(async () => undefined);
    const reader = {
      cancel,
      read: vi.fn(async () => ({ done: false, value: { byteLength: 4 * 1024 * 1024 * 1024 + 1 } })),
    };
    const response = {
      body: { getReader: () => reader },
      headers: new Headers(),
      ok: true,
      status: 200,
      url: "https://host/down",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(fetchRemoteFiles([{ url: "https://host/down" }])).rejects.toMatchObject({
      kind: "too-large",
    });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(vfs.remove).toHaveBeenCalledTimes(1);
  });

  it("aborts sibling downloads and cleans a fulfilled sibling on batch failure", async () => {
    const stored = new File(["ok"], "stored.bin");
    vfs.getFile.mockResolvedValue(stored);
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => responseFor(new Uint8Array([1]), {}, { url: "https://host/ok" }));
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("blocked");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRemoteFiles([{ url: "https://host/ok" }, { url: "https://host/fail" }])).rejects.toMatchObject({
      kind: "blocked",
    });
    expect(vfs.remove).toHaveBeenCalled();
  });

  it("rejects an outer signal before starting any fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchRemoteFiles([], controller.signal)).rejects.toMatchObject({ kind: "aborted", url: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
