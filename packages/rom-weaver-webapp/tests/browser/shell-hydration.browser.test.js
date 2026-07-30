import { Fragment, act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { Masthead, SiteFooter } from "../../src/webapp/components/shell.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const recoverableErrors = [];
  await act(async () => {
    root = hydrateRoot(host, shell(8, "off"), {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
  });

  expect(host.querySelector(".masthead-threads")).toBe(threads);
  expect(host.querySelector(".masthead-runtime")).toBe(runtime);
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

  expect(host.querySelectorAll("[data-beta-tool]").length).toBe(2);
  expect(recoverableErrors).toEqual([]);
  expect(consoleError).not.toHaveBeenCalled();
});
