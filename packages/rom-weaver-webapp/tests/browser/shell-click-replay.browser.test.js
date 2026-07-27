/**
 * The prerendered landing shell is clickable before React's first mount gives it
 * any handler, so those clicks are buffered by an inline script in index.html and
 * re-issued once the mounted tree exists. These tests stand in for that inline
 * script (same buffer shape), swap the shell for a "mounted" copy carrying real
 * listeners, and assert what does and does not get replayed.
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import { captureShellClicks, replayShellClicks } from "../../src/webapp/shell-click-replay.ts";

const SHELL_MARKUP = `
  <header>
    <button aria-label="Settings" class="tool" type="button"><span class="tool-text">Settings</span></button>
    <button class="mode" data-mode="creator" role="tab" type="button">Create</button>
    <button class="tool" disabled type="button">Weave</button>
    <span class="masthead-threads">· 8 threads</span>
  </header>
  <section class="step is-input">
    <label class="drop hero bare"><input id="rom-weaver-input-file-unified" type="file" /></label>
    <button class="ghost" id="rom-weaver-button-reset" type="button">Reset</button>
    <button class="ghost" type="button">Remove</button>
    <button class="ghost" type="button">Remove</button>
  </section>
`;

let appRoot;
let clicked;

// Stands in for the inline capture script in index.html.
const installCaptureBuffer = () => {
  const record = (event) => {
    if (buffer.clicks.length < 4) buffer.clicks.push({ target: event.target, time: Date.now() });
  };
  const buffer = {
    clicks: [],
    stop: () => document.removeEventListener("click", record, true),
  };
  window.ROM_WEAVER_SHELL_CLICKS = buffer;
  document.addEventListener("click", record, true);
  return buffer;
};

// React's first render: identical markup, brand new nodes - these ones listening.
const remountShell = () => {
  appRoot.innerHTML = SHELL_MARKUP;
  for (const element of appRoot.querySelectorAll("button, label")) {
    element.addEventListener("click", () => {
      clicked.push(element.getAttribute("aria-label") || element.id || element.textContent.trim());
    });
  }
};

beforeEach(() => {
  clicked = [];
  appRoot = document.createElement("div");
  appRoot.id = "webapp-root";
  appRoot.innerHTML = SHELL_MARKUP;
  document.body.append(appRoot);
  installCaptureBuffer();
});

afterEach(() => {
  window.ROM_WEAVER_SHELL_CLICKS?.stop();
  delete window.ROM_WEAVER_SHELL_CLICKS;
  appRoot.remove();
});

test("replays a pre-mount click on a button identified by its accessible name", () => {
  appRoot.querySelector('[aria-label="Settings"] .tool-text').click();

  captureShellClicks();
  remountShell();
  // The regression this guards: the shell node that was clicked no longer exists.
  expect(clicked).toEqual([]);

  replayShellClicks(appRoot);
  expect(clicked).toEqual(["Settings"]);
});

test("replays a pre-mount click resolved by id", () => {
  appRoot.querySelector("#rom-weaver-button-reset").click();
  captureShellClicks();
  remountShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual(["rom-weaver-button-reset"]);
});

test("stops capturing at the drain so a post-mount click is never doubled", () => {
  captureShellClicks();
  remountShell();
  appRoot.querySelector('[aria-label="Settings"]').click();
  replayShellClicks(appRoot);

  expect(clicked).toEqual(["Settings"]);
  expect(window.ROM_WEAVER_SHELL_CLICKS.clicks).toEqual([]);
});

test("replays only once even if the mount runs again", () => {
  appRoot.querySelector('[aria-label="Settings"]').click();
  captureShellClicks();
  remountShell();
  replayShellClicks(appRoot);
  replayShellClicks(appRoot);

  expect(clicked).toEqual(["Settings"]);
});

test("drops clicks on gesture-gated targets the browser would block anyway", () => {
  appRoot.querySelector(".drop.hero").click();
  captureShellClicks();
  remountShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual([]);
});

test("drops a click whose target is ambiguous in the mounted tree", () => {
  appRoot.querySelectorAll(".ghost")[1].click();
  captureShellClicks();
  remountShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual([]);
});

test("drops clicks on inert chrome", () => {
  appRoot.querySelector(".masthead-threads").click();
  captureShellClicks();
  remountShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual([]);
});

test("drops clicks that landed too long before the mount", () => {
  appRoot.querySelector('[aria-label="Settings"]').click();
  window.ROM_WEAVER_SHELL_CLICKS.clicks[0].time -= 60_000;
  captureShellClicks();
  remountShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual([]);
});

test("does not replay onto a target the mount left disabled", () => {
  const weave = Array.from(appRoot.querySelectorAll("button")).find((button) => button.textContent === "Weave");
  weave.removeAttribute("disabled");
  weave.click();
  captureShellClicks();
  remountShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual([]);
});

test("caps how many pre-mount clicks are replayed", () => {
  appRoot.querySelector("#rom-weaver-button-reset").click();
  appRoot.querySelector('[role="tab"]').click();
  appRoot.querySelector('[aria-label="Settings"]').click();
  captureShellClicks();
  remountShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual(["rom-weaver-button-reset", "Create"]);
});
