// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReadingProgress } from "../../src/webapp/use-reading-progress.ts";

const setScrollY = (value: number) => Object.defineProperty(window, "scrollY", { configurable: true, value });

describe("useReadingProgress", () => {
  beforeEach(() => {
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrame += 1;
      queueMicrotask(() => callback(performance.now()));
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 1400 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
    setScrollY(0);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns an empty settled state when inactive or there are no sections", () => {
    const { result, rerender } = renderHook(
      ({ active, sections }: { active: boolean; sections: Array<{ id: string }> }) =>
        useReadingProgress(sections, active),
      { initialProps: { active: false, sections: [{ id: "one" }] } },
    );
    expect(result.current).toEqual({ activeIndex: -1, fraction: 0, initializing: false, weights: [] });
    rerender({ active: true, sections: [] });
    expect(result.current).toEqual({ activeIndex: -1, fraction: 0, initializing: false, weights: [] });
  });

  it("measures weighted sections and updates the active marker on scroll and resize", async () => {
    const article = document.createElement("article");
    article.className = "docs-article";
    article.getBoundingClientRect = () => ({ bottom: 1200 - window.scrollY }) as DOMRect;
    document.body.append(article);
    const first = document.createElement("h2");
    first.id = "one";
    first.getBoundingClientRect = () => ({ top: 200 - window.scrollY }) as DOMRect;
    const second = document.createElement("h2");
    second.id = "two";
    second.getBoundingClientRect = () => ({ top: 700 - window.scrollY }) as DOMRect;
    article.append(first, second);

    const sections = [{ id: "one" }, { id: "two" }];
    const { result } = renderHook(() => useReadingProgress(sections, true));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.weights).toEqual([0.5, 0.5]);
    expect(result.current.fraction).toBe(0);

    setScrollY(700);
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(result.current.activeIndex).toBe(1));
    expect(result.current.fraction).toBeCloseTo(0.608);

    setScrollY(1000);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(result.current.fraction).toBe(1));
    expect(result.current.activeIndex).toBe(1);
  });
});
