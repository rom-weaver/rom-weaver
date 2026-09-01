/**
 * The theme toggle's view-transition gate. iOS WebKit is excluded from the
 * flat/mode crossfades because named elements misbehave mid-capture, but the
 * theme wipe names nothing (`html.vt-theme` clears every name), so it must
 * still run the wipe there - that exclusion is what left iOS with no animation.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { Masthead } from "../../src/webapp/components/shell.tsx";

const noop = () => undefined;
const PAGE_TABS = [
  { href: "/apply", icon: null, id: "patcher", label: "Apply" },
  { href: "/create", icon: null, id: "creator", label: "Create" },
];

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
  const find = () =>
    [...host.querySelectorAll("button.tool")].find((button) =>
      /theme|light|dark/i.test(button.getAttribute("aria-label") ?? ""),
    );
  let toggle = find();
  for (let attempt = 0; !toggle && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    toggle = find();
  }
  if (!toggle) throw new Error("theme toggle never rendered");
  return toggle;
};

const clickThemeToggle = async () => {
  const toggle = await renderMasthead();
  // The store owns the current theme; read it rather than assuming a direction.
  const before = document.documentElement.getAttribute("data-theme");
  toggle.click();
  return { before, toggle };
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
    const { toggle } = await clickThemeToggle();

    const rect = toggle.getBoundingClientRect();
    const root_ = document.documentElement;
    expect(root_.style.getPropertyValue("--wipe-x")).toBe(`${rect.left + rect.width / 2}px`);
    expect(root_.style.getPropertyValue("--wipe-y")).toBe(`${rect.top + rect.height / 2}px`);
    expect(Number.parseFloat(root_.style.getPropertyValue("--wipe-r"))).toBeGreaterThan(0);
  });

  test("keeps vt-theme held when a second toggle overlaps the first", async () => {
    pretendIosWebKit();
    const settlers = stubDeferredViewTransitions();
    const toggle = await renderMasthead();

    toggle.click();
    toggle.click();
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
