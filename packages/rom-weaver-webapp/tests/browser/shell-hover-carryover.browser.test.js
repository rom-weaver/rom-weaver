/**
 * React replaces the prerendered landing shell rather than hydrating it, and a
 * node created under a stationary cursor starts out unhovered until the pointer
 * next moves. These tests drive a real pointer so the swap reproduces that loss,
 * then assert the carryover hands the hero drop zone's hover look back.
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { captureShellHeroHover, restoreShellHeroHover } from "../../src/webapp/shell-hover-carryover.ts";
// Load the real design system so getComputedStyle sees the production hover rules.
import "../../src/webapp/design-system/index.css";

const HERO_MARKUP = `
  <div class="rw-app">
    <section class="step is-input is-empty">
      <label class="drop hero bare"><span class="main bead"></span></label>
    </section>
  </div>
`;

let appRoot;

const hero = () => appRoot.querySelector(".drop.hero");
const heroBorder = () => getComputedStyle(hero()).borderTopColor;
// React's first render: identical markup, brand new nodes.
const remountShell = () => {
  appRoot.innerHTML = HERO_MARKUP;
};

beforeEach(() => {
  document.documentElement.setAttribute("data-theme", "dark");
  appRoot = document.createElement("div");
  appRoot.id = "webapp-root";
  appRoot.innerHTML = HERO_MARKUP;
  document.body.append(appRoot);
});

afterEach(() => {
  appRoot.remove();
});

test("carries the hero hover across the shell → React swap", async () => {
  const resting = heroBorder();
  await userEvent.hover(hero());
  const hovered = heroBorder();
  expect(hovered).not.toBe(resting);

  captureShellHeroHover(appRoot);
  remountShell();
  // The regression this guards: the pointer never moved, yet the new node is cold.
  expect(heroBorder()).toBe(resting);

  restoreShellHeroHover(appRoot);
  expect(appRoot.getAttribute("data-shell-hover")).toBe("hero");
  expect(heroBorder()).toBe(hovered);
});

test("hands the hover back to the browser on the next pointer event", async () => {
  const resting = heroBorder();
  await userEvent.hover(hero());
  captureShellHeroHover(appRoot);
  remountShell();
  restoreShellHeroHover(appRoot);

  window.dispatchEvent(new PointerEvent("pointermove"));
  expect(appRoot.hasAttribute("data-shell-hover")).toBe(false);
  expect(heroBorder()).toBe(resting);
});

test("leaves an unhovered shell alone", () => {
  const resting = heroBorder();
  captureShellHeroHover(appRoot);
  remountShell();
  restoreShellHeroHover(appRoot);

  expect(appRoot.hasAttribute("data-shell-hover")).toBe(false);
  expect(heroBorder()).toBe(resting);
});
