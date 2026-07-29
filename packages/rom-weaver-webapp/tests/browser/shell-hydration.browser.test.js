import { Fragment, act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { DropZone } from "../../src/public/react/components/ds/layout.tsx";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { Masthead, SiteFooter } from "../../src/webapp/components/shell.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The mismatch detector is the markup itself, NOT an `onRecoverableError` callback: the runtime is
// preact/compat, whose `hydrateRoot(container, children)` takes no options argument and whose
// `hydrate` silently patches a mismatch instead of reporting one. A correct hydration of markup that
// already matches its props must therefore leave innerHTML byte-identical - any rewrite IS the
// mismatch. "detects markup that does not match its props" below is the negative control that keeps
// this assertion honest; delete it and the next runtime swap can quietly go undetected again.
const hydrateAndDiff = async (host, element) => {
  const before = host.innerHTML;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let root;
  await act(async () => {
    root = hydrateRoot(host, element);
  });
  return { after: host.innerHTML, before, consoleError, root };
};

const tabs = [
  { href: "weave", icon: createElement("svg", { "aria-hidden": true }), id: "patcher", label: "Weave" },
  { href: "create", icon: createElement("svg", { "aria-hidden": true }), id: "creator", label: "Create" },
  { href: "trim", icon: createElement("svg", { "aria-hidden": true }), id: "trim", label: "Trim" },
  { href: "tools", icon: createElement("svg", { "aria-hidden": true }), id: "tools", label: "Tools" },
];

const shell = (threads, serviceWorkerStatus, betaToolsEnabled = false) =>
  createElement(
    RomWeaverSettingsProvider,
    { settings: { betaToolsEnabled } },
    createElement(
      Fragment,
      null,
      createElement(Masthead, {
        currentTab: "patcher",
        onOpenLog: () => undefined,
        onOpenSettings: () => undefined,
        onReset: () => undefined,
        onSelectTab: () => undefined,
        tabs,
      }),
      createElement(SiteFooter, {
        serviceWorkerStatus,
        threads,
        version: "1.2.3",
      }),
    ),
  );

let root;

afterEach(async () => {
  if (root) await act(() => root.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test("hydrates parser-resolved thread and runtime nodes in place", async () => {
  const host = document.createElement("div");
  host.innerHTML = renderToString(shell(1, null));
  document.body.append(host);

  const threads = host.querySelector(".masthead-threads");
  const runtime = host.querySelector(".masthead-runtime");
  threads.querySelector(".masthead-threads-full").textContent = "· 8 threads";
  threads.querySelector(".masthead-threads-short").textContent = "· 8T";
  threads.querySelector(".sr-only").textContent = "8 threads";
  threads.title = "8 threads";
  runtime.textContent = "· web · sw off";
  runtime.title = "Service-worker offline support is unavailable.";

  const diff = await hydrateAndDiff(host, shell(8, "off"));
  root = diff.root;

  expect(host.querySelector(".masthead-threads")).toBe(threads);
  expect(host.querySelector(".masthead-runtime")).toBe(runtime);
  expect(diff.after).toBe(diff.before);
  expect(diff.consoleError).not.toHaveBeenCalled();
});

test("detects markup that does not match its props", async () => {
  const host = document.createElement("div");
  host.innerHTML = renderToString(shell(1, null));
  document.body.append(host);
  // Leave the parser-resolved nodes stale, so the props below genuinely disagree with the markup.

  const diff = await hydrateAndDiff(host, shell(8, "off"));
  root = diff.root;

  expect(diff.after).not.toBe(diff.before);
});

test("keeps useId label associations stable across the prerender handoff", async () => {
  const host = document.createElement("div");
  const dropZone = () => createElement(DropZone, { label: "Add files", onFiles: () => undefined });
  host.innerHTML = renderToString(dropZone());
  document.body.append(host);

  // preact's useId derives its value from vnode tree position rather than a render counter, so a
  // prerendered id only survives hydration while the two trees stay structurally identical. When it
  // drifts, htmlFor stops resolving and the drop zone's label silently detaches from its input -
  // with no runtime warning, because preact hydration does not report mismatches.
  const serverInputId = host.querySelector("input[type=file]").id;
  expect(serverInputId).toBeTruthy();
  expect(host.querySelector("label.drop").htmlFor).toBe(serverInputId);

  const diff = await hydrateAndDiff(host, dropZone());
  root = diff.root;

  expect(host.querySelector("input[type=file]").id).toBe(serverInputId);
  expect(host.querySelector("label.drop").htmlFor).toBe(serverInputId);
  expect(diff.after).toBe(diff.before);
});

test("hydrates the beta navigation in place when the persisted flag is enabled", async () => {
  const host = document.createElement("div");
  host.innerHTML = renderToString(shell(8, null));
  document.body.append(host);
  document.documentElement.dataset.betaToolsEnabled = "true";

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const recoverableErrors = [];
  await act(async () => {
    root = hydrateRoot(host, shell(8, "off", true), {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
  });

  expect(host.querySelectorAll("[data-beta-tool]").length).toBe(2);
  expect(recoverableErrors).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
});
