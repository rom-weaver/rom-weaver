// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../src/presentation/localization/catalog.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
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

beforeAll(async () => {
  await Promise.all([loadCatalog("de"), loadCatalog("es")]);
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

    const { container, unmount } = render(<HomeLoom ariaLabel="The original ROM has three patches." />);
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
    render(<HomeLoom ariaLabel="The original ROM has three patches." />);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(context.save.mock.calls.length).toBe(3);
    expect(context.fill.mock.calls.length).toBeGreaterThan(0);
  });

  it("adopts the loop the shell started on the hydrated canvas and stops it on unmount", () => {
    // A real context, so a mount that ignored the parked loop would start a
    // second loop and fail the frame assertion below.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(makeContext());
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    // The prerendered shell: the same markup, already in the document, with the
    // inline script's loop parked on window for the mount to pick up.
    const container = document.createElement("div");
    container.innerHTML = renderToString(<HomeLoom ariaLabel="The original ROM has three patches." />);
    document.body.append(container);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const shellLoom = { canvas, stop: vi.fn() };
    (window as Window & { ROM_WEAVER_SHELL_LOOM?: typeof shellLoom }).ROM_WEAVER_SHELL_LOOM = shellLoom;

    const { unmount } = render(<HomeLoom ariaLabel="The original ROM has three patches." />, {
      container,
      hydrate: true,
    });
    expect(container.querySelector("canvas")).toBe(canvas);
    expect((window as Window & { ROM_WEAVER_SHELL_LOOM?: unknown }).ROM_WEAVER_SHELL_LOOM).toBeUndefined();
    // No second loop: the shell's frames keep drawing.
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(shellLoom.stop).not.toHaveBeenCalled();
    unmount();
    expect(shellLoom.stop).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it("stops a shell loop that draws on another canvas and starts its own", () => {
    const context = makeContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    // Hydration fell back to a client render, so the shell's canvas is gone.
    const shellLoom = { canvas: document.createElement("canvas"), stop: vi.fn() };
    (window as Window & { ROM_WEAVER_SHELL_LOOM?: typeof shellLoom }).ROM_WEAVER_SHELL_LOOM = shellLoom;

    render(<HomeLoom ariaLabel="The original ROM has three patches." />);
    expect(shellLoom.stop).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect((window as Window & { ROM_WEAVER_SHELL_LOOM?: unknown }).ROM_WEAVER_SHELL_LOOM).toBeUndefined();
  });
});

describe("HomePage", () => {
  it("builds sub-path-safe workflow links and includes the public workflow copy", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomePage baseUrl="https://example.com/tools/" />
      </RomWeaverSettingsProvider>,
    );
    const links = Array.from(container.querySelectorAll("a.home-flow")).map((link) => link.getAttribute("href"));
    expect(links).toEqual([
      "/tools/apply-patch",
      "/tools/apply-patch?guide=bundle",
      "/tools/create-patch",
      "/tools/test-rom",
    ]);
    expect(container.querySelector("#home-title")?.textContent).toContain("Your ROMs. Your changes.");
    expect(container.querySelectorAll(".home-flow")).toHaveLength(4);
    expect(container.textContent).toContain("All on your device.");
    expect(
      Array.from(container.querySelectorAll(".home-install-code")).every(
        (code) => code instanceof HTMLTextAreaElement && code.readOnly,
      ),
    ).toBe(true);
  });

  it("falls back to root-relative routes when the base URL is invalid", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language: "en" }}>
        <HomePage baseUrl="not a URL" />
      </RomWeaverSettingsProvider>,
    );
    expect(container.querySelector("a.btn.primary")?.getAttribute("href")).toBe("/apply-patch");
    expect(container.querySelector("a[href='/create-patch']")).toBeTruthy();
  });

  it("updates homepage copy and workflow names when the language changes", () => {
    const { container, rerender } = render(
      <RomWeaverSettingsProvider settings={{ language: "de" }}>
        <HomePage baseUrl="https://example.com/tools/" />
      </RomWeaverSettingsProvider>,
    );
    expect(container.querySelector("#home-title")?.textContent).toContain("Deine ROMs. Deine Änderungen.");
    expect(container.querySelector("a.home-flow h3")?.textContent).toContain("Patch anwenden");
    expect(container.textContent).toContain("Befehlszeile");

    rerender(
      <RomWeaverSettingsProvider settings={{ language: "es" }}>
        <HomePage baseUrl="https://example.com/tools/" />
      </RomWeaverSettingsProvider>,
    );
    expect(container.querySelector("#home-title")?.textContent).toContain("Tus ROM. Tus cambios.");
    expect(container.querySelector("a.home-flow h3")?.textContent).toContain("Aplicar parche");
    expect(container.textContent).toContain("Línea de comandos");
  });
});
