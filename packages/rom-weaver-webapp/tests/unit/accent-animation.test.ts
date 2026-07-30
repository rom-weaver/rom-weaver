// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyAccent } from "../../src/webapp/accent.ts";

/**
 * The `accent-anim` class arms the --thread crossfade in accents.css. It must
 * skip the boot apply (index.html already resolved data-accent pre-paint, so a
 * dissolve on load would fade from the wrong colour) and come off again after
 * the transition so later theme flips stay instant.
 *
 * Module state in accent.ts (current accent + first-apply flag) carries across
 * tests, so these run as one ordered sequence from the fresh-import state.
 */

describe("accent switch animation class", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  test("the boot apply never animates, even when it changes the accent", () => {
    applyAccent("woad");
    expect(document.documentElement.getAttribute("data-accent")).toBe("woad");
    expect(document.documentElement.classList.contains("accent-anim")).toBe(false);
  });

  test("a later accent change animates, then the class comes off", () => {
    applyAccent("teal");
    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
    expect(document.documentElement.classList.contains("accent-anim")).toBe(true);
    vi.advanceTimersByTime(600);
    expect(document.documentElement.classList.contains("accent-anim")).toBe(false);
  });

  test("re-applying the current accent does not animate", () => {
    applyAccent("teal");
    expect(document.documentElement.classList.contains("accent-anim")).toBe(false);
  });

  test("back-to-back changes restart the removal timer instead of cutting the second fade short", () => {
    applyAccent("plum");
    vi.advanceTimersByTime(400);
    applyAccent("violet");
    vi.advanceTimersByTime(400);
    expect(document.documentElement.classList.contains("accent-anim")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(document.documentElement.classList.contains("accent-anim")).toBe(false);
  });
});
