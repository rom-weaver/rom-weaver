// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BundleApplySession } from "../../src/lib/bundle/bundle-session-model.ts";
import { useUrlSessionBoot } from "../../src/webapp/url-session/use-url-session-boot.ts";

const { fetchRemoteFiles, loadBundleUrlSession, RemoteFetchError } = vi.hoisted(() => ({
  fetchRemoteFiles: vi.fn(),
  loadBundleUrlSession: vi.fn(),
  RemoteFetchError: class extends Error {
    kind: "blocked" | "http" | "too-large" | "aborted";
    constructor(kind: "blocked" | "http" | "too-large" | "aborted", message: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

vi.mock("../../src/lib/remote/remote-file-fetch.ts", () => ({ fetchRemoteFiles, RemoteFetchError }));
vi.mock("../../src/webapp/url-session/bundle-url-session.ts", () => ({ loadBundleUrlSession }));

const requestDirect = {
  kind: "direct" as const,
  patchUrls: ["https://cdn.example/patch.ips"],
  romUrl: "https://cdn.example/game.nes",
};
const requestBundle = { bundleUrl: "https://cdn.example/bundle.json", kind: "bundle" as const };
const session = {
  entries: [{ fileName: "patch.ips", id: "patch-1", optional: false }],
  key: "https://cdn.example/bundle.json",
  outputDefaults: {},
  warnings: [],
} as unknown as BundleApplySession;

const fetched = (name: string) => ({
  cleanup: vi.fn(async () => undefined),
  file: new File([name], name),
});

describe("useUrlSessionBoot", () => {
  beforeEach(() => {
    fetchRemoteFiles.mockReset();
    loadBundleUrlSession.mockReset();
  });

  it("fetches direct ROM and patches together, reports progress, and delivers order", async () => {
    const rom = fetched("game.nes");
    const patch = fetched("patch.ips");
    fetchRemoteFiles.mockImplementation(async (entries: Array<{ onProgress?: (progress: unknown) => void }>) => {
      entries.forEach((entry, index) => {
        entry.onProgress?.({ loadedBytes: index + 1, totalBytes: 10 });
      });
      return [rom, patch];
    });
    const deliver = vi.fn();
    const { result } = renderHook(() => useUrlSessionBoot(requestDirect, deliver));
    await waitFor(() => expect(result.current.state.phase).toBe("done"));

    expect(deliver).toHaveBeenCalledWith([rom.file, patch.file]);
    expect(result.current.state).toMatchObject({ loadedBytes: 3, phase: "done", totalBytes: 20 });
    expect(fetchRemoteFiles).toHaveBeenCalledWith(expect.any(Array), expect.any(AbortSignal));
  });

  it("cleans downloaded direct files when unmounted before the fetch settles", async () => {
    let resolveFetch!: (files: unknown[]) => void;
    fetchRemoteFiles.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const deliver = vi.fn();
    const { unmount } = renderHook(() => useUrlSessionBoot(requestDirect, deliver));
    unmount();
    const rom = fetched("game.nes");
    const patch = fetched("patch.ips");
    resolveFetch([rom, patch]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deliver).not.toHaveBeenCalled();
    expect(rom.cleanup).toHaveBeenCalledOnce();
    expect(patch.cleanup).toHaveBeenCalledOnce();
  });

  it("surfaces typed remote errors and retries the same request", async () => {
    fetchRemoteFiles.mockRejectedValueOnce(new RemoteFetchError("blocked", "CORS denied"));
    const goodRom = fetched("game.nes");
    const goodPatch = fetched("patch.ips");
    fetchRemoteFiles.mockResolvedValueOnce([goodRom, goodPatch]);
    const deliver = vi.fn();
    const { result } = renderHook(() => useUrlSessionBoot(requestDirect, deliver));
    await waitFor(() => expect(result.current.state.phase).toBe("error"));
    expect(result.current.state).toMatchObject({ errorDetail: "CORS denied", errorKind: "blocked" });

    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.state.phase).toBe("done"));
    expect(deliver).toHaveBeenCalledWith([goodRom.file, goodPatch.file]);
    expect(fetchRemoteFiles).toHaveBeenCalledTimes(2);
  });

  it("loads bundles, forwards names and progress, and suffixes session keys on retry", async () => {
    const files = [new File(["rom"], "game.nes"), new File(["patch"], "patch.ips")];
    const cleanup = vi.fn(async () => undefined);
    loadBundleUrlSession.mockImplementation(
      async (
        _url: string,
        hooks: { onBundleName?: (name: string) => void; onProgress?: (id: string, progress: unknown) => void },
      ) => {
        hooks.onBundleName?.("Example bundle");
        hooks.onProgress?.("rom", { loadedBytes: 3, totalBytes: 3 });
        return { cleanup, files, session };
      },
    );
    const deliver = vi.fn();
    const onBundleSession = vi.fn();
    const { result } = renderHook(() => useUrlSessionBoot(requestBundle, deliver, onBundleSession));
    await waitFor(() => expect(result.current.state.phase).toBe("done"));

    expect(deliver).toHaveBeenCalledWith(files);
    expect(onBundleSession).toHaveBeenCalledWith({ ...session, key: `${session.key}#0` });
    expect(result.current.state).toMatchObject({ bundleName: "Example bundle", loadedBytes: 3, totalBytes: 3 });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("does not turn an abort into a visible error", async () => {
    fetchRemoteFiles.mockRejectedValue(new RemoteFetchError("aborted", "download aborted"));
    const deliver = vi.fn();
    const { result } = renderHook(() => useUrlSessionBoot(requestDirect, deliver));
    await waitFor(() => expect(result.current.state.phase).toBe("fetching"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.state.phase).not.toBe("error");
  });
});
