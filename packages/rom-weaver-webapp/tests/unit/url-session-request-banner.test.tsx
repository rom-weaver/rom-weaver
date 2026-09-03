// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readUrlSessionRequest } from "../../src/webapp/url-session/url-session-request.ts";
import { UrlSessionBanner } from "../../src/webapp/url-session/url-session-banner.tsx";

describe("readUrlSessionRequest", () => {
  it("prefers a bundle and warns when direct sources are also present", () => {
    expect(readUrlSessionRequest("?bundle=./bundle.json&rom=rom.bin&patch=one.ips", "https://host.test/app/")).toEqual({
      request: { kind: "bundle", bundleUrl: "https://host.test/app/bundle.json" },
      warnings: ["bundle= takes precedence; rom=/patch= params are ignored"],
    });
  });

  it("resolves direct sources, ignores invalid protocols, and handles empty searches", () => {
    expect(
      readUrlSessionRequest(
        "?rom=rom.bin&patch=https://cdn.test/a.ips&patch=javascript:bad&patch=",
        "https://host.test/app/",
      ),
    ).toEqual({
      request: {
        kind: "direct",
        romUrl: "https://host.test/app/rom.bin",
        patchUrls: ["https://cdn.test/a.ips"],
      },
      warnings: ["patch URL must use http(s): javascript:bad"],
    });
    expect(readUrlSessionRequest("", "https://host.test/app/")).toEqual({ request: null, warnings: [] });
    expect(readUrlSessionRequest("?rom=javascript:bad", "https://host.test/app/")).toEqual({
      request: null,
      warnings: ["rom URL must use http(s): javascript:bad"],
    });
  });
});

const state = (overrides: Record<string, unknown> = {}) => ({
  phase: "fetching",
  loadedBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
  bundleName: "demo bundle",
  errorDetail: "",
  errorKind: undefined,
  ...overrides,
});

describe("UrlSessionBanner", () => {
  it("shows named byte progress and a retry action for blocked errors", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<UrlSessionBanner onRetry={onRetry} state={state()} />);
    expect(screen.getByRole("status").textContent).toContain("demo bundle - 1.0 MiB / 4.0 MiB");

    rerender(
      <UrlSessionBanner
        onRetry={onRetry}
        state={state({ errorDetail: "CORS denied", errorKind: "blocked", phase: "error", totalBytes: null })}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("CORS denied");
    expect(screen.getByRole("status").textContent).toContain("CORS");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("stays hidden after a completed session", () => {
    const { container } = render(<UrlSessionBanner onRetry={vi.fn()} state={state({ phase: "done" })} />);
    expect((container.querySelector(".reveal") as HTMLElement).hidden).toBe(true);
  });
});
