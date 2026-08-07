import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseManifest,
  prefetchEmulatorAssets,
  scheduleEmulatorAssetPrefetch,
  type EmulatorAssetManifest,
} from "../../src/webapp/pwa/emulator-prefetch.ts";

const BASE_URL = "https://example.test/app/";

const manifest: EmulatorAssetManifest = parseManifest({
  files: [
    { path: "cores/first.data", sizeBytes: 10 },
    { path: "cores/second.data", sizeBytes: 20 },
    { path: "loader.js", sizeBytes: 30 },
  ],
  version: "4.2.3",
});

const createFetcher = (failedPaths = new Set<string>()) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/emulatorjs/manifest.json")) return Response.json(manifest);
    const path = url.split("/emulatorjs/data/")[1];
    if (failedPaths.has(path)) return new Response("failed", { status: 503 });
    return new Response("asset");
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("emulator prefetch", () => {
  it("downloads every manifest asset and continues after a failed file", async () => {
    const fetcher = createFetcher(new Set(["cores/second.data"]));

    const result = await prefetchEmulatorAssets(BASE_URL, { fetch: fetcher });

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      `${BASE_URL}emulatorjs/manifest.json`,
      `${BASE_URL}emulatorjs/data/cores/first.data`,
      `${BASE_URL}emulatorjs/data/cores/second.data`,
      `${BASE_URL}emulatorjs/data/loader.js`,
    ]);
    expect(result).toEqual({ downloadedFiles: 2, failedFiles: ["cores/second.data"] });
  });

  it("waits before starting a controlled service-worker prefetch", async () => {
    vi.useFakeTimers();
    const fetcher = createFetcher();
    const controller = {} as ServiceWorker;
    const serviceWorker = {
      controller,
      ready: Promise.resolve({ scope: BASE_URL }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const cleanup = scheduleEmulatorAssetPrefetch({
      delayMs: 1000,
      fetch: fetcher,
      navigator: { serviceWorker },
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledWith(
      `${BASE_URL}emulatorjs/manifest.json`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    cleanup();
  });

  it("waits for the service worker to control the page", async () => {
    vi.useFakeTimers();
    const fetcher = createFetcher();
    let controller: ServiceWorker | null = null;
    let controllerChange: (() => void) | undefined;
    const serviceWorker = {
      get controller() {
        return controller;
      },
      ready: Promise.resolve({ scope: BASE_URL }),
      addEventListener: vi.fn((_type: "controllerchange", listener: () => void) => {
        controllerChange = listener;
      }),
      removeEventListener: vi.fn(),
    };

    const cleanup = scheduleEmulatorAssetPrefetch({
      delayMs: 1000,
      fetch: fetcher,
      navigator: { serviceWorker },
    });
    expect(serviceWorker.addEventListener).toHaveBeenCalledWith("controllerchange", expect.any(Function));

    controller = {} as ServiceWorker;
    controllerChange?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalled();
    cleanup();
  });

  it.each(["", "/absolute.data", "cores\\file.data", "cores//file.data", "cores/./file.data", "cores/../file.data"])(
    "rejects unsafe asset path %j",
    (path) => {
      expect(() => parseManifest({ files: [{ path, sizeBytes: 1 }], version: "4.2.3" })).toThrow(
        /EmulatorJS asset manifest/,
      );
    },
  );
});
