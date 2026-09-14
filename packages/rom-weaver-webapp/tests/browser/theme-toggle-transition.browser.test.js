/**
 * The theme wipe clears view-transition names, so the iOS gate for named-element crossfades must not disable it.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
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
let originalStart;
let originalSupports;

/** Minimal stand-in: the real API is absent in this engine. */
const stubViewTransitions = () => {
  startCalls = [];
  // The original method is restored after the test double runs.
  // oxlint-disable-next-line typescript/unbound-method
  originalStart = document.startViewTransition;
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
  // The original method is restored after the deferred test double runs.
  // oxlint-disable-next-line typescript/unbound-method
  originalStart = document.startViewTransition;
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

/* Theme is a named menu rather than a cycle, so the wipe runs from the chosen
   row. The origin it is fed is still the control that opened the menu. */
const pickTheme = async (toggle, value) => {
  toggle.click();
  const anchor = toggle.closest(".tool-anchor");
  const rows = () => [...anchor.querySelectorAll('[role="menuitemradio"]')];
  for (let attempt = 0; rows().length === 0 && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The origin is read when the choice commits, and the open menu is part of
  // the layout at that moment, so the rect has to be taken there too.
  const rect = toggle.getBoundingClientRect();
  rows()[THEME_CHOICE[value]].click();
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

  test("feeds the wipe its origin from the button", async () => {
    pretendIosWebKit();
    const { rect } = await clickThemeToggle();

    const root_ = document.documentElement;
    expect(root_.style.getPropertyValue("--wipe-x")).toBe(`${rect.left + rect.width / 2}px`);
    expect(root_.style.getPropertyValue("--wipe-y")).toBe(`${rect.top + rect.height / 2}px`);
    expect(Number.parseFloat(root_.style.getPropertyValue("--wipe-r"))).toBeGreaterThan(0);
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
