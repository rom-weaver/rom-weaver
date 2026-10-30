/**
 * The prerendered landing shell is clickable before React's first mount gives it
 * any handler, so those clicks are buffered by an inline script in index.html and
 * re-issued once the hydrated tree has handlers. These tests stand in for that
 * inline script (same buffer shape), attach listeners to the retained shell
 * nodes, and assert what does and does not get replayed.
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import indexHtml from "../../index.html?raw";
import { captureShellClicks, replayShellClicks, replayShellSelections } from "../../src/webapp/shell-click-replay.ts";

const SHELL_MARKUP = `
  <header>
    <button aria-label="Settings" class="tool" type="button"><span class="tool-text">Settings</span></button>
    <button class="mode" data-mode="creator" role="tab" type="button">Create</button>
    <button class="tool" disabled type="button">Apply</button>
    <span class="brand-hy">-</span>
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

// React hydration: the existing shell nodes gain handlers in place.
const hydrateShell = () => {
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

test("replays a pre-mount click on its retained hydrated button", () => {
  const settings = appRoot.querySelector('[aria-label="Settings"]');
  settings.querySelector(".tool-text").click();

  captureShellClicks();
  hydrateShell();
  expect(appRoot.querySelector('[aria-label="Settings"]')).toBe(settings);
  expect(clicked).toEqual([]);

  replayShellClicks(appRoot);
  expect(clicked).toEqual(["Settings"]);
});

test("stops capturing at the drain so a post-mount click is never doubled", () => {
  captureShellClicks();
  hydrateShell();
  appRoot.querySelector('[aria-label="Settings"]').click();
  replayShellClicks(appRoot);

  expect(clicked).toEqual(["Settings"]);
  expect(window.ROM_WEAVER_SHELL_CLICKS.clicks).toEqual([]);
});

test("replays only once even if the mount runs again", () => {
  appRoot.querySelector('[aria-label="Settings"]').click();
  captureShellClicks();
  hydrateShell();
  replayShellClicks(appRoot);
  replayShellClicks(appRoot);

  expect(clicked).toEqual(["Settings"]);
});

test("drops clicks on gesture-gated targets the browser would block anyway", () => {
  appRoot.querySelector(".drop.hero").click();
  captureShellClicks();
  hydrateShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual([]);
});

test("drops clicks on inert chrome", () => {
  appRoot.querySelector(".brand-hy").click();
  captureShellClicks();
  hydrateShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual([]);
});

test("drops clicks that landed too long before the mount", () => {
  appRoot.querySelector('[aria-label="Settings"]').click();
  window.ROM_WEAVER_SHELL_CLICKS.clicks[0].time -= 60_000;
  captureShellClicks();
  hydrateShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual([]);
});

test("does not replay onto a target the mount left disabled", () => {
  const apply = Array.from(appRoot.querySelectorAll("button")).find((button) => button.textContent === "Apply");
  apply.removeAttribute("disabled");
  apply.click();
  captureShellClicks();
  apply.setAttribute("disabled", "");
  hydrateShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual([]);
});

test("caps how many pre-mount clicks are replayed", () => {
  appRoot.querySelector("#rom-weaver-button-reset").click();
  appRoot.querySelector('[role="tab"]').click();
  appRoot.querySelector('[aria-label="Settings"]').click();
  captureShellClicks();
  hydrateShell();
  replayShellClicks(appRoot);

  expect(clicked).toEqual(["rom-weaver-button-reset", "Create"]);
});

// File picks and drops: the real inline script from index.html is evaluated, so
// the buffer shape and the replay cannot drift apart.
const installRealCaptureScript = () => {
  window.ROM_WEAVER_SHELL_CLICKS?.stop();
  const script = indexHtml.match(/<script>\s*\/\/ Buffer clicks[\s\S]*?<\/script>/i)[0];
  const element = document.createElement("script");
  element.textContent = script.replace(/^<script>|<\/script>$/gi, "");
  document.head.append(element);
  element.remove();
};

const makeFiles = (...names) => names.map((name) => new File([name], name));
const transferOf = (files) => {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  return transfer;
};
const settle = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20)));

// Stands in for React's handlers on the retained zone: onChange then a value reset, onDrop.
const hydrateZone = (received) => {
  const input = appRoot.querySelector("#rom-weaver-input-file-unified");
  input.addEventListener("change", () => {
    received.push(["pick", Array.from(input.files, (file) => file.name)]);
    input.value = "";
  });
  appRoot.addEventListener("drop", (event) => {
    received.push(["drop", Array.from(event.dataTransfer.files, (file) => file.name)]);
  });
  return input;
};

test("delivers a multi-file pick made before the mount to the hydrated input", async () => {
  installRealCaptureScript();
  const input = appRoot.querySelector("#rom-weaver-input-file-unified");
  input.files = transferOf(makeFiles("a.bin", "b.ips")).files;
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const received = [];
  captureShellClicks();
  hydrateZone(received);
  replayShellSelections(appRoot);
  await settle();

  expect(received).toEqual([["pick", ["a.bin", "b.ips"]]]);
});

test("does not deliver a pick the mounted tree already consumed", async () => {
  installRealCaptureScript();
  const input = appRoot.querySelector("#rom-weaver-input-file-unified");
  input.files = transferOf(makeFiles("a.bin")).files;
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const received = [];
  captureShellClicks();
  hydrateZone(received);
  input.value = "";
  replayShellSelections(appRoot);
  await settle();

  expect(received).toEqual([]);
});

test("moves a pick onto the replacement input when the mount rebuilt the shell", async () => {
  installRealCaptureScript();
  const input = appRoot.querySelector("#rom-weaver-input-file-unified");
  input.files = transferOf(makeFiles("a.bin")).files;
  input.dispatchEvent(new Event("change", { bubbles: true }));

  captureShellClicks();
  appRoot.innerHTML = SHELL_MARKUP;
  const received = [];
  hydrateZone(received);
  replayShellSelections(appRoot);
  await settle();

  expect(received).toEqual([["pick", ["a.bin"]]]);
});

test("claims and re-delivers a multi-file drop made before the mount", async () => {
  installRealCaptureScript();
  const over = new DragEvent("dragover", {
    bubbles: true,
    cancelable: true,
    dataTransfer: transferOf(makeFiles("a.bin")),
  });
  appRoot.querySelector(".drop.hero").dispatchEvent(over);
  const drop = new DragEvent("drop", {
    bubbles: true,
    cancelable: true,
    dataTransfer: transferOf(makeFiles("a.bin", "b.ips")),
  });
  appRoot.querySelector(".drop.hero").dispatchEvent(drop);
  expect(over.defaultPrevented).toBe(true);
  expect(drop.defaultPrevented).toBe(true);

  const received = [];
  captureShellClicks();
  hydrateZone(received);
  replayShellSelections(appRoot);
  await settle();

  expect(received).toEqual([["drop", ["a.bin", "b.ips"]]]);
});

test("leaves non-file drags alone and delivers once while the handoff settles", async () => {
  installRealCaptureScript();
  const textDrop = new DragEvent("drop", { bubbles: true, cancelable: true });
  appRoot.dispatchEvent(textDrop);
  expect(textDrop.defaultPrevented).toBe(false);

  const received = [];
  captureShellClicks();
  hydrateZone(received);
  replayShellSelections(appRoot);
  appRoot
    .querySelector(".drop.hero")
    .dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transferOf(makeFiles("late.bin")) }),
    );
  await settle();

  expect(received).toEqual([["drop", ["late.bin"]]]);
  expect(window.ROM_WEAVER_SHELL_CLICKS.selections).toEqual([]);
});

test("delivers every pick made on the same input before the mount", async () => {
  installRealCaptureScript();
  const input = appRoot.querySelector("#rom-weaver-input-file-unified");
  for (const name of ["rom.sfc", "fix.ips"]) {
    input.files = transferOf(makeFiles(name)).files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const received = [];
  captureShellClicks();
  hydrateZone(received);
  replayShellSelections(appRoot);
  await settle();

  expect(received).toEqual([
    ["pick", ["rom.sfc"]],
    ["pick", ["fix.ips"]],
  ]);
});

test("delivers drops in order when a new drop lands after hydration begins", async () => {
  installRealCaptureScript();
  const zone = appRoot.querySelector(".drop.hero");
  const dropFiles = (...names) =>
    zone.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transferOf(makeFiles(...names)) }),
    );
  dropFiles("early.bin");

  const received = [];
  captureShellClicks();
  hydrateZone(received);
  // Selections during hydration MUST wait behind the buffered earlier drop.
  dropFiles("racing.bin");
  replayShellSelections(appRoot);
  await settle();

  expect(received).toEqual([
    ["drop", ["early.bin"]],
    ["drop", ["racing.bin"]],
  ]);
});
