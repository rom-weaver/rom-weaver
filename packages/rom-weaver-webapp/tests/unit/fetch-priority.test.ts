import { afterEach, describe, expect, it, vi } from "vitest";
import { prioritizePrecacheInstallRequest } from "../../src/webapp/pwa/fetch-priority.ts";

describe("fetch priority", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clones an install request with low priority", () => {
    const requestConstructor = vi.fn();
    const request = {} as Request;
    vi.stubGlobal("Request", requestConstructor);

    prioritizePrecacheInstallRequest(request, { type: "install" });

    expect(requestConstructor).toHaveBeenCalledWith(request, { priority: "low" });
  });

  it("keeps a runtime cache-miss request at its original priority", () => {
    const requestConstructor = vi.fn();
    const request = {} as Request;
    vi.stubGlobal("Request", requestConstructor);

    expect(prioritizePrecacheInstallRequest(request, { type: "fetch" })).toBe(request);
    expect(requestConstructor).not.toHaveBeenCalled();
  });

  it("preserves the original request properties", () => {
    const request = new Request("https://example.com/app.js", {
      headers: { "X-Test": "preserved" },
    });

    const prioritized = prioritizePrecacheInstallRequest(request, { type: "install" });

    expect(prioritized.url).toBe(request.url);
    expect(prioritized.method).toBe(request.method);
    expect(prioritized.headers.get("X-Test")).toBe("preserved");
  });
});
