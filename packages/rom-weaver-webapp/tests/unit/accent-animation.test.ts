// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let applyAccent: typeof import("../../src/webapp/accent.ts").applyAccent;

describe("accent switch animation class", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ applyAccent } = await import("../../src/webapp/accent.ts"));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    document.documentElement.classList.remove("accent-anim");
    document.documentElement.removeAttribute("data-accent");
  });

  test("the boot apply never animates, even when it changes the accent", () => {
    applyAccent("woad");
    expect(document.documentElement.getAttribute("data-accent")).toBe("woad");
    expect(document.documentElement.classList.contains("accent-anim")).toBe(false);
  });

  test("a later accent change animates, then the class comes off", () => {
    applyAccent("woad");
    applyAccent("teal");
    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
    expect(document.documentElement.classList.contains("accent-anim")).toBe(true);
    vi.advanceTimersByTime(600);
    expect(document.documentElement.classList.contains("accent-anim")).toBe(false);
  });

  test("re-applying the current accent does not animate", () => {
    applyAccent("teal");
    applyAccent("teal");
    expect(document.documentElement.classList.contains("accent-anim")).toBe(false);
  });

  test("back-to-back changes restart the removal timer instead of cutting the second fade short", () => {
    applyAccent("teal");
    applyAccent("plum");
    vi.advanceTimersByTime(400);
    applyAccent("violet");
    vi.advanceTimersByTime(400);
    expect(document.documentElement.classList.contains("accent-anim")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(document.documentElement.classList.contains("accent-anim")).toBe(false);
  });
});
