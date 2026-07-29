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

// A long marquee to catch a clone that restarts instead of resuming.
const keyframes = document.createElement("style");
keyframes.textContent = `
  @keyframes wipe-drift { from { opacity: 1; } to { opacity: .2; } }
  .wipe-pseudo::before { content: ""; display: block; animation: wipe-drift 30s linear infinite; }
  .wipe-oneshot { animation: wipe-drift 40ms linear 1; }
`;
document.head.append(keyframes);

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

  test("the clone keeps animations moving in step instead of restarting them", async () => {
    const marquee = document.createElement("div");
    marquee.className = "wipe-marquee";
    marquee.style.animation = "wipe-drift 30s linear infinite";
    fixture.append(marquee);
    const live = marquee.getAnimations()[0];
    // Mid-stride: a clone left to its own devices would start over at 0.
    live.currentTime = 9000;

    runThemeWipeFallback(ORIGIN, flipTo("light"));
    const clonedMarquee = veils()[0].querySelector(".wipe-marquee");
    const cloned = clonedMarquee.getAnimations()[0];

    expect(cloned).toBeDefined();
    expect(cloned.playState).not.toBe("paused");
    expect(cloned.startTime).toBe(live.startTime);
    expect(Math.abs(cloned.currentTime - live.currentTime)).toBeLessThan(50);

    // Sharing the timeline origin keeps them in step as time passes.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(Math.abs(cloned.currentTime - live.currentTime)).toBeLessThan(50);
    await settle();
  });

  test("syncs pseudo-element animations and drops one-shots that already played", async () => {
    const pseudo = document.createElement("div");
    pseudo.className = "wipe-pseudo";
    const oneShot = document.createElement("div");
    oneShot.className = "wipe-oneshot";
    fixture.append(pseudo, oneShot);
    const livePseudo = pseudo.getAnimations({ subtree: true })[0];
    livePseudo.currentTime = 12000;
    // Let the one-shot finish, so the live page is no longer animating it.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(oneShot.getAnimations()).toHaveLength(0);

    runThemeWipeFallback(ORIGIN, flipTo("light"));
    const veil = veils()[0];
    const clonedPseudo = veil.querySelector(".wipe-pseudo").getAnimations({ subtree: true })[0];

    // ::before animations are invisible to element.getAnimations() — they were
    // left restarting at 0 until the sync walked the subtree.
    expect(clonedPseudo).toBeDefined();
    expect(Math.abs(clonedPseudo.currentTime - livePseudo.currentTime)).toBeLessThan(50);
    // The finished one-shot must not play again inside the circle.
    expect(veil.querySelector(".wipe-oneshot").getAnimations()).toHaveLength(0);
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

  test("flips with transitions suppressed and only then lifts the clone", async () => {
    const root = document.documentElement;
    // Colour transitions would otherwise replay the outgoing theme in full
    // view the moment the veil lifts.
    const suppressedWithVeilUp = [];
    const observer = new MutationObserver(() => {
      if (root.classList.contains("theme-wipe-settle")) {
        suppressedWithVeilUp.push({
          theme: root.getAttribute("data-theme"),
          veilUp: veils().length === 1,
          bodyTransition: getComputedStyle(document.body).transitionProperty,
        });
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });

    runThemeWipeFallback(ORIGIN, flipTo("light"));
    await settle();
    observer.disconnect();

    expect(suppressedWithVeilUp).toHaveLength(1);
    // The flip lands under a clone that is still covering the viewport.
    expect(suppressedWithVeilUp[0]).toMatchObject({ theme: "light", veilUp: true, bodyTransition: "none" });
    expect(root.classList.contains("theme-wipe-settle")).toBe(false);
    expect(getComputedStyle(document.body).transitionProperty).not.toBe("none");
    expect(veils()).toHaveLength(0);
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
    // The first wipe is settled on the spot - flipped, and lifting on its own
    // two-frame delay - so the second one starts from the theme it landed on.
    expect(flips).toBe(1);
    expect(veils()[veils().length - 1].getAttribute("data-theme")).toBe("dark");

    await settle();
    expect(flips).toBe(2);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(veils()).toHaveLength(0);
  });
});
