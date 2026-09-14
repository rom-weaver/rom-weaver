import { Fragment, act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { Masthead } from "../../src/webapp/components/shell.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tabs = [
  {
    dock: true,
    group: "patches",
    href: "apply",
    icon: createElement("svg", { "aria-hidden": true }),
    id: "patcher",
    label: "Apply",
  },
  {
    dock: true,
    group: "patches",
    href: "create",
    icon: createElement("svg", { "aria-hidden": true }),
    id: "creator",
    label: "Create",
  },
  {
    dock: true,
    group: "roms",
    href: "test",
    icon: createElement("svg", { "aria-hidden": true }),
    id: "test",
    label: "Test",
  },
  {
    beta: true,
    group: "roms",
    href: "trim",
    icon: createElement("svg", { "aria-hidden": true }),
    id: "trim",
    label: "Trim",
  },
  {
    beta: true,
    group: "patches",
    href: "ppf-undo",
    icon: createElement("svg", { "aria-hidden": true }),
    id: "ppf-undo",
    label: "PPF undo",
  },
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
        onOpenWhatsNew: () => undefined,
        onOpenLog: () => undefined,
        onOpenSettings: () => undefined,
        onOpenStatus: () => undefined,
        onSelectTab: () => undefined,
        serviceWorkerStatus,
        tabs,
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

  // Exactly what the parser-time resolver in index.html writes before React
  // loads: the count, its accessible name, and the runtime state, title, glyph,
  // and lucide class.
  const threads = host.querySelector(".masthead-threads");
  const runtime = host.querySelector(".sub-status");
  threads.querySelector(".masthead-threads-count").textContent = "8";
  threads.setAttribute("aria-label", "8 threads");
  runtime.dataset.sw = "disabled";
  runtime.setAttribute("aria-label", "Offline support off");
  runtime.setAttribute("title", "Offline support off");
  runtime.querySelector("svg").setAttribute("class", "lucide lucide-cloud-off");
  runtime.querySelector("svg").innerHTML =
    '<path d="M10.94 5.274A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 4.222 6.057"></path><path d="M18.796 18.81A4.5 4.5 0 0 1 17.5 19H9A7 7 0 0 1 5.79 5.78"></path><path d="m2 2 20 20"></path>';

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const recoverableErrors = [];
  await act(async () => {
    root = hydrateRoot(host, shell(8, "off"), {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
  });

  expect(host.querySelector(".masthead-threads")).toBe(threads);
  expect(host.querySelector(".sub-status")).toBe(runtime);
  expect(recoverableErrors).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
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

  // The nav names every workflow, beta ones included; the dock keeps its three
  // slots plus Menu, and everything else reaches the phone through that sheet.
  // The sheet itself is empty until it is first opened, so the shell ships one
  // copy of the rows rather than two.
  expect(host.querySelectorAll(".side-nav .nav-row").length).toBeGreaterThan(4);
  expect(host.querySelectorAll(".menu-sheet .nav-row").length).toBe(0);
  expect(host.querySelectorAll('.side-nav .nav-row[href="trim"]').length).toBe(1);
  expect(host.querySelectorAll(".dock .dock-tab").length).toBe(4);
  expect(recoverableErrors).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
});
