/**
 * The theme wipe clears view-transition names, so the iOS gate for named-element crossfades must not disable it.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { applyAccent } from "../../src/webapp/accent.ts";
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";
import { Masthead } from "../../src/webapp/components/shell.tsx";

const noop = () => undefined;
const PAGE_TABS = [
  { group: "patches", href: "/apply-patch", icon: null, id: "patcher", label: "Apply Patch" },
  { group: "patches", href: "/create-patch", icon: null, id: "creator", label: "Create Patch" },
];
const THEME_CHOICE = { auto: 2, dark: 1, light: 0 };

let host;
let root;
let startCalls;
let animationCalls;
let originalStart;
let originalAnimate;
let originalSupports;

/** Minimal stand-in: the real API is absent in this engine. */
const stubViewTransitions = () => {
  startCalls = [];
  animationCalls = [];
  // The original method is restored after the test double runs.
  // oxlint-disable-next-line typescript/unbound-method
  originalStart = document.startViewTransition;
  originalAnimate = document.documentElement.animate.bind(document.documentElement);
  document.documentElement.animate = (...args) => {
    animationCalls.push(args);
    return originalAnimate(...args);
  };
  document.startViewTransition = (update) => {
    startCalls.push(update);
    update();
    return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
  };
};

/** Make the iOS/iPadOS probe in flat-transition.ts report a match. */
const pretendIosWebKit = () => {
  originalSupports = CSS.supports;
  CSS.supports = (property, value) =>
    property === "-webkit-touch-callout" ? true : originalSupports.call(CSS, property, value);
};

/** Like the stub above, but the caller decides when each run finishes. */
const stubDeferredViewTransitions = () => {
  startCalls = [];
  const settlers = [];
  document.startViewTransition = (update) => {
    startCalls.push(update);
    update();
    let settle;
    const finished = new Promise((resolve) => {
      settle = resolve;
    });
    settlers.push(settle);
    return { finished, ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
  };
  return settlers;
};

const renderMasthead = async () => {
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    createElement(
      RomWeaverSettingsProvider,
      { settings: {} },
      createElement(Masthead, {
        currentTab: "patcher",
        onOpenWhatsNew: noop,
        onOpenLog: noop,
        onOpenSettings: noop,
        onOpenStatus: noop,
        onAccentChange: applyAccent,
        onSelectTab: noop,
        tabs: PAGE_TABS,
      }),
    ),
  );
  const find = () => host.querySelector('.topbar-tools .tool[aria-label^="Theme"]');
  let toggle = find();
  for (let attempt = 0; !toggle && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    toggle = find();
  }
  if (!toggle) throw new Error("theme control never rendered");
  return toggle;
};

/* The wipe starts at the chosen row in the theme menu. */
const pickTheme = async (toggle, value) => {
  toggle.click();
  const anchor = toggle.closest(".tool-anchor");
  const rows = () => [...anchor.querySelectorAll('[role="menuitemradio"]')];
  for (let attempt = 0; rows().length === 0 && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const choice = rows()[THEME_CHOICE[value]];
  const rect = choice.getBoundingClientRect();
  choice.click();
  return rect;
};

const clickThemeToggle = async () => {
  const toggle = await renderMasthead();
  // The store owns the current theme; read it rather than assuming a direction.
  const before = document.documentElement.getAttribute("data-theme");
  const rect = await pickTheme(toggle, before === "dark" ? "light" : "dark");
  return { before, rect, toggle };
};

describe("theme toggle view-transition gate", () => {
  beforeEach(() => {
    stubViewTransitions();
  });
  afterEach(() => {
    root?.unmount();
    host?.remove();
    document.startViewTransition = originalStart;
    document.documentElement.animate = originalAnimate;
    if (originalSupports) CSS.supports = originalSupports;
    originalSupports = undefined;
    document.documentElement.classList.remove("vt-theme");
  });

  test("runs the wipe on iOS WebKit instead of snapping", async () => {
    pretendIosWebKit();
    const { before } = await clickThemeToggle();

    expect(startCalls).toHaveLength(1);
    expect(document.documentElement.getAttribute("data-theme")).not.toBe(before);
  });

  test("feeds the wipe its origin from the clicked choice", async () => {
    pretendIosWebKit();
    const { rect } = await clickThemeToggle();
    await Promise.resolve();

    const [keyframes, options] = animationCalls.at(-1);
    expect(options.pseudoElement).toBe("::view-transition-new(root)");
    const radiusPercent = Number(keyframes[1].clipPath.match(/^circle\(([\d.]+)%/)[1]);
    const radius = ((radiusPercent / 100) * Math.hypot(window.innerWidth, window.innerHeight)) / Math.SQRT2;
    expect(radius).toBeCloseTo(
      Math.hypot(
        Math.max(rect.left + rect.width / 2, window.innerWidth - rect.left - rect.width / 2),
        Math.max(rect.top + rect.height / 2, window.innerHeight - rect.top - rect.height / 2),
      ),
    );
    expect(keyframes[0].clipPath).toBe(
      `circle(0% at ${((rect.left + rect.width / 2) / window.innerWidth) * 100}% ${((rect.top + rect.height / 2) / window.innerHeight) * 100}%)`,
    );
  });

  test("keeps a touch origin when the browser reports a detail-zero click", async () => {
    pretendIosWebKit();
    const toggle = await renderMasthead();
    toggle.click();
    const anchor = toggle.closest(".tool-anchor");
    let rows = [...anchor.querySelectorAll('[role="menuitemradio"]')];
    for (let attempt = 0; rows.length === 0 && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      rows = [...anchor.querySelectorAll('[role="menuitemradio"]')];
    }
    const choice = rows[THEME_CHOICE.dark];
    const rect = choice.getBoundingClientRect();
    const clickX = Math.round(rect.left + 9);
    const clickY = Math.round(rect.top + 11);
    choice.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: clickX,
        clientY: clickY,
        pointerType: "touch",
      }),
    );
    choice.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: clickX, clientY: clickY, detail: 0 }));
    await Promise.resolve();

    const [keyframes] = animationCalls.at(-1);
    expect(keyframes[0].clipPath).toBe(
      `circle(0% at ${(clickX / window.innerWidth) * 100}% ${(clickY / window.innerHeight) * 100}%)`,
    );
  });

  test("dissolves an accent change without a circular wipe", async () => {
    pretendIosWebKit();
    await renderMasthead();
    const toggle = host.querySelector(".topbar-tools .accent-tool");
    toggle.click();
    const findChoice = () => host.querySelector('.topbar-tools .accent-chip:has(input[value="woad"])');
    let choice = findChoice();
    for (let attempt = 0; !choice && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      choice = findChoice();
    }
    if (!choice) throw new Error("accent choice never rendered");
    const rect = choice.getBoundingClientRect();
    const clickX = Math.round(rect.left + 7);
    const clickY = Math.round(rect.top + 9);
    choice.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: clickX,
        clientY: clickY,
        pointerType: "touch",
      }),
    );
    choice
      .querySelector("input")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: clickX, clientY: clickY, detail: 0 }));
    await Promise.resolve();

    expect(startCalls).toHaveLength(1);
    const [keyframes, options] = animationCalls.at(-1);
    expect(keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(options.duration).toBe(340);
    expect(document.documentElement.getAttribute("data-accent")).toBe("woad");
  });

  test("uses the same accent dissolve after keyboard navigation", async () => {
    pretendIosWebKit();
    await renderMasthead();
    const toggle = host.querySelector(".topbar-tools .accent-tool");
    toggle.click();
    let inputs = [...host.querySelectorAll(".topbar-tools .accent-chip input")];
    for (let attempt = 0; inputs.length === 0 && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      inputs = [...host.querySelectorAll(".topbar-tools .accent-chip input")];
    }
    const selected = inputs.find((input) => input.checked);
    const target = inputs.find((input) => !input.checked);
    if (!(selected && target)) throw new Error("accent choices never rendered");
    const selectedRect = selected.closest("label").getBoundingClientRect();
    const staleX = Math.round(selectedRect.left + 3);
    const staleY = Math.round(selectedRect.top + 3);
    selected.closest("label").dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: staleX,
        clientY: staleY,
        pointerType: "touch",
      }),
    );
    selected.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    target.click();
    await Promise.resolve();

    const [keyframes] = animationCalls.at(-1);
    expect(keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  test("keeps vt-theme held when a second toggle overlaps the first", async () => {
    pretendIosWebKit();
    const settlers = stubDeferredViewTransitions();
    const toggle = await renderMasthead();

    await pickTheme(toggle, "light");
    await pickTheme(toggle, "dark");
    expect(startCalls).toHaveLength(2);

    // The first run settles while the second is still animating; its release
    // must not strip the class the live run's wipe depends on.
    settlers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.documentElement.classList.contains("vt-theme")).toBe(true);

    settlers[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.documentElement.classList.contains("vt-theme")).toBe(false);
  });

  test("falls back to an instant flip where the API is missing", async () => {
    document.startViewTransition = undefined;
    const { before } = await clickThemeToggle();

    expect(document.documentElement.getAttribute("data-theme")).not.toBe(before);
    expect(document.documentElement.classList.contains("vt-theme")).toBe(false);
  });
});

describe("rendered appearance snapshots", () => {
  afterEach(() => {
    root?.unmount();
    host?.remove();
  });

  test("reveals settled theme colors from the control with native snapshots", async () => {
    const toggle = await renderMasthead();
    const surface = document.createElement("div");
    surface.style.cssText = "background-color: var(--chassis); transition: background-color 10s";
    host.append(surface);
    const before = getComputedStyle(surface).backgroundColor;
    const rect = await pickTheme(toggle, document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    const findAnimation = () =>
      document.getAnimations().find((animation) => animation.effect?.pseudoElement === "::view-transition-new(root)");
    await expect.poll(findAnimation).toBeTruthy();
    const animation = findAnimation();
    animation.pause();
    animation.currentTime = 100;
    try {
      expect(getComputedStyle(surface).backgroundColor).not.toBe(before);
      expect(getComputedStyle(surface).transitionDuration).toBe("0s");
      expect(getComputedStyle(surface).backgroundColor).toBe(
        document.documentElement.dataset.theme === "dark" ? "rgb(7, 9, 11)" : "rgb(236, 233, 225)",
      );
      const frames = animation.effect.getKeyframes();
      const origin = frames[0].clipPath.match(/at ([\d.]+)% ([\d.]+)%/);
      expect((Number(origin[1]) / 100) * window.innerWidth).toBeCloseTo(rect.left + rect.width / 2, 1);
      expect((Number(origin[2]) / 100) * window.innerHeight).toBeCloseTo(rect.top + rect.height / 2, 1);
      expect(getComputedStyle(document.documentElement).clipPath).toBe("none");
      expect(host.querySelector('[role="menu"]')).toBeNull();
    } finally {
      animation.finish();
      await animation.finished;
      await expect.poll(() => document.documentElement.classList.contains("vt-theme")).toBe(false);
      expect(findAnimation()).toBeUndefined();
    }
  });
});
