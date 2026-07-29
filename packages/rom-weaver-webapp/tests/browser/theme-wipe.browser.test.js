/**
 * The hand-painted theme wipe used where view transitions are unavailable
 * (iOS WebKit). Covers the revealed clone, the state it carries over, the
 * single theme flip, and the veil lifecycle.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runThemeWipeFallback } from "../../src/webapp/theme-wipe.ts";
import "../../src/webapp/design-system/index.css";

const ORIGIN = { x: 40, y: 20, radius: 800 };

const veils = () => document.querySelectorAll(".theme-veil");
const settle = () => new Promise((resolve) => setTimeout(resolve, 900));
const flipTo = (theme) => () => document.documentElement.setAttribute("data-theme", theme);

let fixture;

describe("theme wipe fallback", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    fixture = document.createElement("div");
    fixture.id = "wipe-fixture";
    fixture.innerHTML = `<p class="hero-lead">woven</p><input id="wipe-input" />`;
    document.body.append(fixture);
  });
  afterEach(async () => {
    await settle();
    fixture.remove();
    document.documentElement.setAttribute("data-theme", "dark");
  });

  test("reveals a clone of the page in the incoming theme, then flips once", async () => {
    let flips = 0;
    runThemeWipeFallback(ORIGIN, () => {
      flips += 1;
      document.documentElement.setAttribute("data-theme", "light");
    });

    const veil = veils()[0];
    expect(veil).toBeDefined();
    // The clone carries the incoming theme while the live page still shows the old one.
    expect(veil.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(veil.style.clipPath).toContain("circle(0px at 40px 20px)");

    const clonedLead = veil.querySelector(".hero-lead");
    expect(clonedLead?.textContent).toBe("woven");
    // Content stays visible inside the circle instead of being covered.
    expect(getComputedStyle(clonedLead).visibility).toBe("visible");
    expect(veil.contains(document.getElementById("wipe-input"))).toBe(false);

    await settle();
    expect(flips).toBe(1);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(veils()).toHaveLength(0);
  });

  test("the clone carries live state cloneNode would drop", async () => {
    const input = fixture.querySelector("#wipe-input");
    input.value = "typed after render";

    runThemeWipeFallback(ORIGIN, flipTo("light"));
    const clonedInput = veils()[0].querySelector("#wipe-input");

    expect(clonedInput.value).toBe("typed after render");
    await settle();
  });

  test("the veil is inert and hidden from assistive tech", async () => {
    runThemeWipeFallback(ORIGIN, flipTo("light"));
    const veil = veils()[0];

    expect(veil.getAttribute("aria-hidden")).toBe("true");
    expect(veil.inert).toBe(true);
    expect(getComputedStyle(veil).pointerEvents).toBe("none");
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
