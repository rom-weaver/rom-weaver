import { describe, expect, it, vi } from "vitest";
import {
  syncEmulatorAssets,
  type EmulatorAssetCache,
  type EmulatorAssetFetch,
  type EmulatorAsset,
  type EmulatorAssetManifest,
  type EmulatorAssetSyncFailure,
  type EmulatorAssetSyncProgress,
} from "../../src/webapp/pwa/emulator-asset-sync.ts";

const BASE_URL = "https://example.test/app/";
const manifestFiles: EmulatorAsset[] = [
  { path: "cores/first.data", sizeBytes: 10 },
  { path: "cores/second.data", sizeBytes: 20 },
  { path: "loader.js", sizeBytes: 30 },
];
const manifest: EmulatorAssetManifest = {
  files: manifestFiles,
  version: "4.2.3",
};

const assetUrl = (path: string) => new URL(`emulatorjs/data/${path}`, BASE_URL).href;

const createCache = (cachedPaths: readonly string[] = []) => {
  const entries = new Map<string, Response>(
    cachedPaths.map((path) => [assetUrl(path), new Response(`cached:${path}`)]),
  );
  const match = vi.fn(async (request) => entries.get(String(request))?.clone());
  const put = vi.fn(async (request, response) => {
    entries.set(String(request), response.clone());
  });
  const cache: EmulatorAssetCache = { match, put };
  return { cache, entries, match, put };
};

const createFetcher = (responses = new Map<string, Response | Error>()) =>
  vi.fn<EmulatorAssetFetch>(async (input) => {
    const response = responses.get(String(input));
    if (response instanceof Error) throw response;
    return response ?? new Response(`asset:${String(input)}`);
  });

describe("syncEmulatorAssets", () => {
  it("resumes from cached assets and skips them on the next run", async () => {
    const { cache } = createCache(["cores/first.data"]);
    const fetcher = createFetcher();
    const progress: EmulatorAssetSyncProgress[] = [];

    const first = await syncEmulatorAssets(manifest, {
      baseUrl: BASE_URL,
      cache,
      fetch: fetcher,
      onProgress: (next) => progress.push(next),
    });
    fetcher.mockClear();

    const second = await syncEmulatorAssets(manifest, { baseUrl: BASE_URL, cache, fetch: fetcher });

    expect(first.progress).toMatchObject({ bytesDone: 60, filesDone: 3, skippedFiles: 1 });
    expect(second.progress).toMatchObject({ bytesDone: 60, filesDone: 3, skippedFiles: 3 });
    expect(second.failures).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(progress[0]).toMatchObject({ bytesDone: 10, filesDone: 1, skippedFiles: 1 });
  });

  it("writes every successful response to the dedicated cache", async () => {
    const { cache, entries, put } = createCache();
    const fetcher = createFetcher();

    await syncEmulatorAssets(manifest, { baseUrl: BASE_URL, cache, fetch: fetcher });

    expect(put).toHaveBeenCalledTimes(3);
    for (const file of manifest.files) {
      expect(await entries.get(assetUrl(file.path))?.text()).toBe(`asset:${assetUrl(file.path)}`);
    }
  });

  it("continues after a failed file and reports it", async () => {
    const { cache } = createCache();
    const fetcher = createFetcher(new Map([[assetUrl("cores/second.data"), new Error("network failed")]]));

    const result = await syncEmulatorAssets(manifest, { baseUrl: BASE_URL, cache, fetch: fetcher });

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual(
      manifest.files.map((file) => assetUrl(file.path)),
    );
    const failure: EmulatorAssetSyncFailure = { message: "network failed", path: "cores/second.data" };
    expect(result.failures).toEqual([failure]);
    expect(result.progress).toMatchObject({ bytesDone: 40, failedFiles: 1, filesDone: 2, totalFiles: 3 });
  });

  it("cancels without reporting the aborted request as a failure", async () => {
    const { cache } = createCache();
    const controller = new AbortController();
    const fetcher = vi.fn<EmulatorAssetFetch>(async (_input, init) => {
      expect(init?.credentials).toBe("same-origin");
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new Error("aborted");
    });

    const result = await syncEmulatorAssets(manifest, {
      baseUrl: BASE_URL,
      cache,
      fetch: fetcher,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.progress).toMatchObject({ bytesDone: 0, failedFiles: 0, filesDone: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["", "/absolute.data", "cores//file.data", "cores/./file.data", "cores/../file.data"])(
    "rejects unsafe asset path %j",
    async (path) => {
      const { cache, match } = createCache();
      const fetcher = createFetcher();

      await expect(
        syncEmulatorAssets(
          { files: [{ path, sizeBytes: 1 }], version: "4.2.3" },
          { baseUrl: BASE_URL, cache, fetch: fetcher },
        ),
      ).rejects.toThrow(/EmulatorJS asset/);
      expect(fetcher).not.toHaveBeenCalled();
      expect(match).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { version: 4, files: [] },
    { version: "4.2.3", files: {} },
    { version: "4.2.3", files: [null] },
    { version: "4.2.3", files: [{ path: "loader.js", sizeBytes: -1 }] },
    { version: "4.2.3", files: [{ path: "loader.js", sizeBytes: 1.5 }] },
    {
      version: "4.2.3",
      files: [
        { path: "loader.js", sizeBytes: 1 },
        { path: "loader.js", sizeBytes: 1 },
      ],
    },
  ])("rejects invalid manifest shape %#", async (value) => {
    const { cache, match } = createCache();
    const fetcher = createFetcher();

    await expect(
      syncEmulatorAssets(value as EmulatorAssetManifest, { baseUrl: BASE_URL, cache, fetch: fetcher }),
    ).rejects.toThrow(/EmulatorJS asset manifest/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
  });
});
