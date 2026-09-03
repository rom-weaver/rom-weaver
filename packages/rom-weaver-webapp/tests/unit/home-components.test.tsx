// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeLoom } from "../../src/webapp/components/home-loom.tsx";
import { HomePage } from "../../src/webapp/components/home-page.tsx";

const makeContext = () =>
  ({
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    quadraticCurveTo: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
  }) as unknown as CanvasRenderingContext2D;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HomeLoom", () => {
  it("draws the animated weave, responds to resize and dye changes, and cleans up", () => {
    const context = makeContext();
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 180,
      height: 180,
      left: 0,
      right: 560,
      top: 0,
      width: 560,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", { configurable: true, value: 560 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    document.documentElement.style.setProperty("--well", "#111");
    document.documentElement.style.setProperty("--warp-a", "#222");
    document.documentElement.style.setProperty("--warp-b", "#333");
    document.documentElement.style.setProperty("--shuttle", "#444");
    document.documentElement.style.setProperty("--loom-weft-1", "#555");
    document.documentElement.style.setProperty("--loom-weft-2", "#666");
    document.documentElement.style.setProperty("--loom-weft-3", "#777");

    const { container, unmount } = render(<HomeLoom />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.getAttribute("role")).toBe("img");
    expect(canvas.getAttribute("aria-label")).toContain("three patches");
    expect(context.setTransform.mock.calls.length).toBeGreaterThan(0);
    expect(frames.size).toBe(1);

    const initialFrame = frames.values().next().value as FrameRequestCallback;
    initialFrame(3_000);
    expect(context.clearRect.mock.calls.length).toBeGreaterThan(0);
    expect(context.save.mock.calls.length).toBeGreaterThan(0);
    expect(context.restore.mock.calls.length).toBeGreaterThan(0);
    window.dispatchEvent(new Event("resize"));
    document.documentElement.setAttribute("data-theme", "dark");
    for (const callback of frames.values()) callback(10_000);
    expect(context.setTransform.mock.calls.length).toBeGreaterThan(1);

    unmount();
    window.dispatchEvent(new Event("resize"));
    expect(context.setTransform.mock.calls.length).toBeGreaterThan(1);
  });

  it("paints all rows immediately when reduced motion is enabled", () => {
    const context = makeContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<HomeLoom />);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(context.save.mock.calls.length).toBe(3);
    expect(context.fill.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("HomePage", () => {
  it("builds sub-path-safe workflow links and includes the public workflow copy", () => {
    const { container } = render(<HomePage baseUrl="https://example.com/tools/" />);
    const links = Array.from(container.querySelectorAll("a.home-flow")).map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/tools/apply", "/tools/apply?guide=bundle", "/tools/create", "/tools/test"]);
    expect(container.querySelector("#home-title")?.textContent).toContain("Patch, pack, and prove");
    expect(container.querySelectorAll(".home-flow")).toHaveLength(4);
    expect(container.textContent).toContain("Nothing leaves your machine");
  });

  it("falls back to root-relative routes when the base URL is invalid", () => {
    const { container } = render(<HomePage baseUrl="not a URL" />);
    expect(container.querySelector("a.btn.primary")?.getAttribute("href")).toBe("/apply");
    expect(container.querySelector("a[href='/create']")).toBeTruthy();
  });
});
