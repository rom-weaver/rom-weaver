// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectBrowserRuntimeDiagnostics } from "../../src/webapp/browser-runtime-diagnostics.ts";

type DiagnosticsApi = {
  collect: () => Promise<Awaited<ReturnType<typeof collectBrowserRuntimeDiagnostics>>>;
  copy: () => Promise<Awaited<ReturnType<typeof collectBrowserRuntimeDiagnostics>>>;
  log: () => Promise<Awaited<ReturnType<typeof collectBrowserRuntimeDiagnostics>>>;
};

const getDiagnosticsApi = () =>
  (window as Window & { ROM_WEAVER_BROWSER_DIAGNOSTICS?: DiagnosticsApi }).ROM_WEAVER_BROWSER_DIAGNOSTICS;

describe("browser runtime diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("collects feature, header, OPFS, storage, and Safari diagnostics", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    const storage = {
      estimate: vi.fn().mockResolvedValue({ quota: 1000, usage: 250, usageDetails: { cache: "12" } }),
      getDirectory: vi.fn().mockResolvedValue({}),
    };
    const safariNavigator = {
      clipboard,
      deviceMemory: 4,
      maxTouchPoints: 5,
      platform: "iPhone",
      serviceWorker: { controller: {} },
      storage,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    };
    vi.stubGlobal("navigator", safariNavigator);
    vi.stubGlobal("crossOriginIsolated", true);
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("", {
          headers: {
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        }),
      ),
    );

    const diagnostics = await collectBrowserRuntimeDiagnostics();

    expect(diagnostics).toMatchObject({
      crossOriginIsolated: true,
      deviceMemory: 4,
      isSecureContext: true,
      maxTouchPoints: 5,
      mobileSafariCandidate: true,
      opfs: { available: true, ok: true },
      platform: "iPhone",
      serviceWorkerController: true,
      storageEstimate: { quota: 1000, usage: 250, usageDetails: { cache: 12 } },
      userAgent: safariNavigator.userAgent,
    });
    expect(diagnostics.headers).toEqual({
      crossOriginEmbedderPolicy: "require-corp",
      crossOriginOpenerPolicy: "same-origin",
      crossOriginResourcePolicy: "same-origin",
    });
    expect(diagnostics.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(storage.getDirectory).toHaveBeenCalledOnce();
    expect(storage.estimate).toHaveBeenCalledOnce();
    expect(getDiagnosticsApi()).toBeTruthy();
    expect(
      (window as Window & { ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS?: DiagnosticsApi })
        .ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS,
    ).toBe(getDiagnosticsApi());
  });

  it("reports probe failures and copies or logs through the installed API", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const storage = {
      estimate: vi.fn().mockRejectedValue("estimate failed"),
      getDirectory: vi.fn().mockRejectedValue(new Error("OPFS failed")),
    };
    vi.stubGlobal("navigator", {
      maxTouchPoints: Number.NaN,
      platform: "MacIntel",
      storage,
      userAgent: "Mozilla/5.0 Chrome/120.0 Safari/537.36",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("headers failed")));

    const diagnostics = await collectBrowserRuntimeDiagnostics();
    expect(diagnostics).toMatchObject({
      deviceMemory: null,
      maxTouchPoints: Number.NaN,
      mobileSafariCandidate: false,
      opfs: { available: true, error: "OPFS failed", ok: false },
      storageEstimate: { error: "estimate failed" },
    });
    expect(diagnostics.headers).toEqual({
      crossOriginEmbedderPolicy: null,
      crossOriginOpenerPolicy: null,
      crossOriginResourcePolicy: null,
      error: "headers failed",
    });

    const api = getDiagnosticsApi();
    expect(api).toBeTruthy();
    const copied = await api?.copy();
    expect(copied).toMatchObject({ opfs: { error: "OPFS failed" } });
    expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining('"storageEstimate"'));
    const logged = await api?.log();
    expect(logged).toEqual(expect.objectContaining({ headers: diagnostics.headers }));
    expect(consoleInfo).toHaveBeenCalledWith("rom-weaver browser runtime diagnostics", logged);
  });

  it("uses the clipboard when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText }, storage: {} });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ headers: new Headers() }));

    await getDiagnosticsApi()?.copy();

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"mobileSafariCandidate"'));
  });
});
