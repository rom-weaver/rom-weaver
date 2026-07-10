// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerBrowserDownload } from "../../src/platform/browser/browser-download.ts";

const IOS_PWA_NAVIGATOR = {
  maxTouchPoints: 5,
  platform: "iPhone",
  standalone: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

const stubIosPwaNavigator = (overrides: Record<string, unknown> = {}) => {
  vi.stubGlobal("navigator", {
    ...IOS_PWA_NAVIGATOR,
    canShare: () => true,
    ...overrides,
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("triggerBrowserDownload (iOS standalone PWA share path)", () => {
  it("shares via navigator.share and skips the anchor download", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubIosPwaNavigator({ share });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    await triggerBrowserDownload(new Blob(["rom"]), "output.sfc");
    expect(share).toHaveBeenCalledTimes(1);
    const shared = share.mock.calls[0][0].files[0] as File;
    expect(shared.name).toBe("output.sfc");
    expect(click).not.toHaveBeenCalled();
  });

  it("swallows share failures on the non-interactive (auto) path", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("no activation", "NotAllowedError"));
    stubIosPwaNavigator({ share });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    await expect(triggerBrowserDownload(new Blob(["rom"]), "output.sfc")).resolves.toBeUndefined();
    expect(click).not.toHaveBeenCalled();
  });

  it("rethrows share failures on the interactive path", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("no activation", "NotAllowedError"));
    stubIosPwaNavigator({ share });
    await expect(triggerBrowserDownload(new Blob(["rom"]), "output.sfc", { interactive: true })).rejects.toThrow(
      /share sheet/,
    );
  });

  it("does not treat user cancellation as an interactive failure", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError"));
    stubIosPwaNavigator({ share });
    await expect(
      triggerBrowserDownload(new Blob(["rom"]), "output.sfc", { interactive: true }),
    ).resolves.toBeUndefined();
  });

  it("falls back to the anchor download outside a standalone PWA", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      maxTouchPoints: 0,
      platform: "MacIntel",
      share,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await triggerBrowserDownload(new Blob(["rom"]), "output.sfc");
    expect(share).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });
});
