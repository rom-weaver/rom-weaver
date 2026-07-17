// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectBrowserInfo } from "../../src/lib/browser-info.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collectBrowserInfo", () => {
  it("captures the core fields from navigator/window", () => {
    const info = collectBrowserInfo();
    expect(typeof info.userAgent).toBe("string");
    expect(typeof info.hardwareConcurrency).toBe("number");
    expect(typeof info.isSecureContext).toBe("boolean");
    expect(typeof info.crossOriginIsolated).toBe("boolean");
    expect(["writeText", "present-no-writeText", "absent"]).toContain(info.clipboardApi);
  });

  it("reports clipboardApi=writeText when the async API is available", () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: () => Promise.resolve() } });
    expect(collectBrowserInfo().clipboardApi).toBe("writeText");
  });

  it("reports clipboardApi=absent when navigator.clipboard is missing (non-secure context)", () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    expect(collectBrowserInfo().clipboardApi).toBe("absent");
  });

  it("reports clipboardApi=present-no-writeText when clipboard exists without writeText", () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: {} });
    expect(collectBrowserInfo().clipboardApi).toBe("present-no-writeText");
  });

  it("joins multiple languages", () => {
    vi.stubGlobal("navigator", { ...navigator, language: "en-US", languages: ["en-US", "en"] });
    expect(collectBrowserInfo().languages).toBe("en-US,en");
  });
});
