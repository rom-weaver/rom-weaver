/**
 * The hand-painted theme wipe used where view transitions are unavailable
 * (iOS WebKit). Covers the veil lifecycle, the single theme flip, and the
 * chassis color it paints.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runThemeWipeFallback } from "../../src/webapp/theme-wipe.ts";
import "../../src/webapp/design-system/index.css";

const ORIGIN = { x: 40, y: 20, radius: 800 };

const veils = () => document.querySelectorAll(".theme-veil");
const settle = () => new Promise((resolve) => setTimeout(resolve, 900));

describe("theme wipe fallback", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  afterEach(() => {
    for (const veil of veils()) veil.remove();
    document.documentElement.setAttribute("data-theme", "dark");
  });

  test("paints a veil, flips the theme once, then cleans up", async () => {
    let flips = 0;
    runThemeWipeFallback(ORIGIN, () => {
      flips += 1;
      document.documentElement.setAttribute("data-theme", "light");
    });

    const veil = veils()[0];
    expect(veil).toBeDefined();
    expect(getComputedStyle(veil).position).toBe("fixed");
    expect(veil.style.clipPath).toContain("circle(0px at 40px 20px)");

    await settle();
    expect(flips).toBe(1);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(veils()).toHaveLength(0);
  });

  test("veil is painted with the incoming theme's chassis and leaves the current theme intact", async () => {
    runThemeWipeFallback(ORIGIN, () => document.documentElement.setAttribute("data-theme", "light"));
    const veil = veils()[0];
    const painted = veil.style.background;
    // Reading the incoming color must not leave the root on the wrong theme.
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    document.documentElement.setAttribute("data-theme", "light");
    const probe = document.createElement("div");
    probe.style.background = getComputedStyle(document.documentElement).getPropertyValue("--chassis").trim();
    document.documentElement.setAttribute("data-theme", "dark");

    expect(painted).toBe(probe.style.background);
    await settle();
  });

  test("a second wipe settles the first instead of stacking veils", async () => {
    let flips = 0;
    const toggle = () => {
      flips += 1;
      const root = document.documentElement;
      root.setAttribute("data-theme", root.getAttribute("data-theme") === "dark" ? "light" : "dark");
    };
    runThemeWipeFallback(ORIGIN, toggle);
    runThemeWipeFallback(ORIGIN, toggle);
    expect(veils()).toHaveLength(1);

    await settle();
    expect(flips).toBe(2);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(veils()).toHaveLength(0);
  });
});
