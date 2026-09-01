// @vitest-environment happy-dom
import { createElement, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUIDED_SAMPLE_START_EVENT } from "../../src/public/react/guided-sample-start.ts";
import type { ServiceWorkerCacheState } from "../../src/webapp/pwa/service-worker-cache-state.ts";
import {
  getDefaultSettings,
  LOCAL_STORAGE_SETTINGS_ID,
  SETTINGS_FIELD_METADATA,
} from "../../src/webapp/settings/settings-state.ts";
import type { WebappRootProps } from "../../src/webapp/webapp-root-types.ts";

type ServiceWorkerClientOptions = {
  onConfirmReload: () => Promise<boolean>;
  onStateChange: () => void;
  shouldAutoApplyUpdate: () => boolean;
};

const mocks = vi.hoisted(() => ({
  collectBrowserInfo: vi.fn(() => ({ userAgent: "test-agent" })),
  getBrowserStorageEstimateState: vi.fn(() => Promise.resolve({ quota: 1, usage: 0 })),
  markRomWeaverRunnerStale: vi.fn(),
  preloadDocsRouteHtml: vi.fn(() => Promise.resolve()),
  preloadWorkflowRoute: vi.fn(() => Promise.resolve()),
  readPwaState: vi.fn(() => false),
  renderDuringHydration: false,
  renders: [] as WebappRootProps[],
  resetBrowserTransientOpfs: vi.fn(() => Promise.resolve()),
  resetRomWeaverRunner: vi.fn(() => Promise.resolve()),
  serviceWorkerCache: {
    label: "cache dev",
    serviceWorkerStatus: "off",
    title: "Loaded service worker cache version",
    updateLabel: "Reload to update",
    updateReady: false,
    updateTitle: "A newer app version is ready.",
  } as ServiceWorkerCacheState,
  serviceWorkerClient: {
    forceCacheAndReload: vi.fn(() => Promise.resolve(true)),
    getState: vi.fn((): ServiceWorkerCacheState => mocks.serviceWorkerCache),
    initialize: vi.fn(),
    refreshCacheVersion: vi.fn(),
    reloadPendingUpdate: vi.fn(() => Promise.resolve(true)),
  },
  serviceWorkerOptions: null as ServiceWorkerClientOptions | null,
  startBrowserOpfsBootCleanup: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/lib/browser-info.ts", () => ({ collectBrowserInfo: mocks.collectBrowserInfo }));
vi.mock("../../src/storage/browser/browser-storage-estimate.ts", () => ({
  getBrowserStorageEstimateState: mocks.getBrowserStorageEstimateState,
}));
vi.mock("../../src/storage/browser/browser-opfs-cleanup.ts", () => ({
  resetBrowserTransientOpfs: mocks.resetBrowserTransientOpfs,
  startBrowserOpfsBootCleanup: mocks.startBrowserOpfsBootCleanup,
}));
vi.mock("../../src/workers/rom-weaver/runner-control.ts", () => ({
  markRomWeaverRunnerStale: mocks.markRomWeaverRunnerStale,
  resetRomWeaverRunner: mocks.resetRomWeaverRunner,
}));
vi.mock("../../src/webapp/pwa/pwa-service-worker-client.ts", () => ({
  createPwaServiceWorkerClient: (options: ServiceWorkerClientOptions) => {
    mocks.serviceWorkerOptions = options;
    return mocks.serviceWorkerClient;
  },
}));
vi.mock("../../src/webapp/components/shell.tsx", () => ({ readPwaState: mocks.readPwaState }));
vi.mock("../../src/webapp/workflow-routes.tsx", () => ({
  preloadDocsRouteHtml: mocks.preloadDocsRouteHtml,
  preloadWorkflowRoute: mocks.preloadWorkflowRoute,
}));
vi.mock("../../src/webapp/webapp-root.tsx", () => ({
  resolveThreads: (threads: unknown) => threads,
  selectViewWithTransition: (apply: () => void) => {
    apply();
  },
  WebappRoot: (props: WebappRootProps) => {
    mocks.renders.push(props);
    // A layout effect on the child runs before the entry's own mount effect, so
    // this is the only place a render can be queued while hydration is open.
    useLayoutEffect(() => {
      if (!mocks.renderDuringHydration) return;
      mocks.renderDuringHydration = false;
      props.actions.onOpenSettings();
    }, [props.actions]);
    return createElement("div", { id: "shell" });
  },
}));

// React 19 schedules hydration and passive work on macrotasks, so microtask
// draining alone never reaches the first commit.
const flush = async () => {
  for (let round = 0; round < 6; round += 1) {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

const consoleText = () =>
  consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
    .join("\n");

type TrackedListener = { listener: EventListenerOrEventListenerObject; target: EventTarget; type: string };

let trackedListeners: TrackedListener[] = [];

/**
 * The entry registers window and document listeners at module scope. happy-dom
 * keeps one document for the whole file, so every reloaded module instance would
 * otherwise stack another copy of them on the same targets.
 */
const withListenerTracking = async (load: () => Promise<void>) => {
  for (const entry of trackedListeners) entry.target.removeEventListener(entry.type, entry.listener);
  trackedListeners = [];
  const targets: EventTarget[] = [window, document];
  const originals = targets.map((target) => target.addEventListener.bind(target));
  targets.forEach((target, index) => {
    target.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      trackedListeners.push({ listener, target, type });
      originals[index]?.(type, listener, options);
    };
  });
  try {
    await load();
  } finally {
    targets.forEach((target, index) => {
      target.addEventListener = originals[index] as EventTarget["addEventListener"];
    });
  }
};

const loadWebapp = async (options?: {
  betaTools?: boolean;
  notFound?: boolean;
  prerendered?: boolean;
  url?: string;
}) => {
  vi.resetModules();
  mocks.renders.length = 0;
  window.history.replaceState({}, "", options?.url ?? "/apply");
  document.documentElement.dataset.page = options?.notFound ? "not-found" : "app";
  document.documentElement.dataset.betaToolsEnabled = options?.betaTools ? "true" : "false";
  document.body.innerHTML = `<div id="webapp-root" aria-busy="true">${
    options?.prerendered ? '<div id="shell"></div>' : ""
  }</div>`;
  await withListenerTracking(async () => {
    await import("../../src/webapp/webapp.ts");
    await flush();
  });
};

const latest = () => {
  const props = mocks.renders.at(-1);
  if (!props) throw new Error("the webapp root never rendered");
  return props;
};

const otherOptionValue = (field: "accent" | "bundlePackage" | "language" | "logLevel") => {
  const current = String(getDefaultSettings()[field]);
  const metadata = SETTINGS_FIELD_METADATA[field];
  const values = metadata.options
    ? metadata.options.map((entry) => entry.value)
    : ((metadata.validValues ?? []) as string[]);
  const value = values.find((entry) => entry !== current);
  if (!value) throw new Error(`no alternative ${field} value to pick`);
  return value;
};

const clickAnchor = (href: string) => {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = "go";
  document.body.append(anchor);
  // Window is the last hop of the bubble path, so the entry's document listener
  // still sees an unprevented event while happy-dom never actually navigates.
  const blockNavigation = (event: Event) => event.preventDefault();
  window.addEventListener("click", blockNavigation);
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
  window.removeEventListener("click", blockNavigation);
  return anchor;
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.renderDuringHydration = false;
  mocks.serviceWorkerCache = {
    label: "cache dev",
    serviceWorkerStatus: "off",
    title: "Loaded service worker cache version",
    updateLabel: "Reload to update",
    updateReady: false,
    updateTitle: "A newer app version is ready.",
  };
  consoleSpies = (["debug", "error", "info", "log", "warn"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("boot", () => {
  it("mounts a client root over an empty shell and reports the app ready", async () => {
    await loadWebapp();

    expect(mocks.startBrowserOpfsBootCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.preloadWorkflowRoute).toHaveBeenCalledWith("patcher");
    expect(mocks.preloadDocsRouteHtml).not.toHaveBeenCalled();
    expect(mocks.serviceWorkerClient.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.serviceWorkerClient.refreshCacheVersion).toHaveBeenCalledTimes(1);
    expect(latest().state.startup).toEqual({ message: "", status: "ready" });
    expect(latest().state.currentView).toBe("patcher");
    expect(latest().notFound).toBe(false);
    const appRoot = document.getElementById("webapp-root");
    expect(appRoot?.hasAttribute("aria-busy")).toBe(false);
    expect(appRoot?.dataset.shellSettled).toBeUndefined();
    expect(consoleText()).toContain("Initializing webapp");
    expect(consoleText()).toContain("Browser environment");
  });

  it("hydrates the prerendered shell with the served document's view and settings", async () => {
    await loadWebapp({ betaTools: true, prerendered: true, url: "/create" });

    const hydrationProps = mocks.renders[0];
    expect(hydrationProps?.state.currentView).toBe("creator");
    expect(hydrationProps?.state.settings.betaToolsEnabled).toBe(true);
    expect(hydrationProps?.state.startup).toEqual({ message: "", status: "ready" });
    expect(hydrationProps?.urlSession).toBeNull();
    expect(hydrationProps?.pageUpdate.ready).toBe(false);
    expect(document.getElementById("webapp-root")?.dataset.shellSettled).toBe("true");
  });

  it("hydrates a view without a prerendered shell as the patcher", async () => {
    await loadWebapp({ prerendered: true, url: "/trim" });

    expect(mocks.renders[0]?.state.currentView).toBe("patcher");
  });

  it("flushes a render that was queued while hydration was still open", async () => {
    mocks.renderDuringHydration = true;

    await loadWebapp({ prerendered: true });

    expect(latest().state.settingsDialogOpen).toBe(true);
    expect(mocks.renders.length).toBeGreaterThan(1);
  });

  it("waits for the docs route html on a docs document", async () => {
    await loadWebapp({ url: "/docs/getting-started" });

    expect(mocks.preloadWorkflowRoute).toHaveBeenCalledWith("docs");
    expect(mocks.preloadDocsRouteHtml).toHaveBeenCalledTimes(1);
    expect(latest().docsSlug).toBeTruthy();
  });

  it("skips the route preload and the history rewrite on the not-found document", async () => {
    await loadWebapp({ notFound: true, url: "/nope" });

    expect(mocks.preloadWorkflowRoute).not.toHaveBeenCalled();
    expect(latest().notFound).toBe(true);
    expect(window.location.pathname).toBe("/nope");
  });

  it("logs a failed initial OPFS cleanup without blocking the boot", async () => {
    mocks.startBrowserOpfsBootCleanup.mockRejectedValue(new Error("opfs unavailable"));

    await loadWebapp();

    expect(consoleText()).toContain("Initial OPFS cleanup failed");
    expect(latest().state.startup.status).toBe("ready");
  });

  it("logs the url session warnings it parsed at boot", async () => {
    await loadWebapp({ url: "/apply?bundle=notaurl&rom=/rom.sfc" });

    expect(consoleText()).toContain("url session: bundle= takes precedence; rom=/patch= params are ignored");
    expect(latest().urlSession?.warnings).toContain("bundle= takes precedence; rom=/patch= params are ignored");
  });

  it("hands a parsed url session request to the root", async () => {
    await loadWebapp({ url: "/apply?rom=/roms/rom.sfc&patch=/patches/a.ips" });

    expect(latest().urlSession?.request).toMatchObject({ kind: "direct" });
    expect(latest().state.currentView).toBe("patcher");
  });

  it("reports the browser storage estimate it could not read", async () => {
    mocks.getBrowserStorageEstimateState.mockRejectedValue(new Error("estimate blocked"));

    await loadWebapp();

    expect(mocks.getBrowserStorageEstimateState).toHaveBeenCalledTimes(1);
  });
});

describe("service worker bridge", () => {
  it("exposes the service worker controls on window", async () => {
    await loadWebapp();
    const bridge = window.ROM_WEAVER_SERVICE_WORKER;
    if (!bridge) throw new Error("the service worker bridge was not installed");

    expect(bridge.getState()).toBe(mocks.serviceWorkerCache);
    bridge.refreshCacheVersion();
    await bridge.forceCacheAndReload();

    expect(mocks.serviceWorkerClient.refreshCacheVersion).toHaveBeenCalledTimes(2);
    expect(mocks.serviceWorkerClient.forceCacheAndReload).toHaveBeenCalledTimes(1);
  });

  it("re-renders when the service worker state changes", async () => {
    await loadWebapp();
    const rendersBefore = mocks.renders.length;

    mocks.serviceWorkerOptions?.onStateChange();
    mocks.serviceWorkerOptions?.onStateChange();
    await flush();

    expect(mocks.renders.length).toBeGreaterThan(rendersBefore);
  });

  it("auto-applies an update only while nothing is staged", async () => {
    await loadWebapp();

    expect(mocks.serviceWorkerOptions?.shouldAutoApplyUpdate()).toBe(true);
    latest().actions.onPatcherInputsChange([{ name: "rom.sfc" }]);
    await flush();
    expect(mocks.serviceWorkerOptions?.shouldAutoApplyUpdate()).toBe(false);
  });

  it("reloads for an update without asking when nothing is staged", async () => {
    await loadWebapp();

    await expect(mocks.serviceWorkerOptions?.onConfirmReload()).resolves.toBe(true);
    expect(latest().confirmationDialog.open).toBe(false);
  });

  it("asks before reloading over staged work", async () => {
    await loadWebapp();
    latest().actions.onPatcherInputsChange([{ name: "rom.sfc" }]);
    await flush();

    const confirmed = mocks.serviceWorkerOptions?.onConfirmReload();
    await flush();
    expect(latest().confirmationDialog).toMatchObject({
      cancelLabel: "Stay here",
      confirmLabel: "Reload now",
      level: "warning",
      message: "You have an in-progress patching session. Reload and lose those changes?",
      open: true,
      title: "Reload and lose changes?",
    });

    latest().actions.onConfirmConfirmation();
    await expect(confirmed).resolves.toBe(true);
    expect(latest().confirmationDialog.open).toBe(false);
  });

  it("routes a pending service worker update through the client", async () => {
    await loadWebapp();

    latest().actions.onReloadUpdate();
    await flush();
    expect(mocks.serviceWorkerClient.reloadPendingUpdate).not.toHaveBeenCalled();

    mocks.serviceWorkerCache = { ...mocks.serviceWorkerCache, updateReady: true };
    latest().actions.onReloadUpdate();
    await flush();
    expect(mocks.serviceWorkerClient.reloadPendingUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("confirmation dialog", () => {
  it("resolves the pending confirmation as declined and closes", async () => {
    await loadWebapp();
    latest().actions.onPatcherInputsChange([{ name: "rom.sfc" }]);
    await flush();

    const confirmed = latest().actions.onConfirmExternalNavigation();
    await flush();
    expect(latest().confirmationDialog).toMatchObject({
      confirmLabel: "Open link",
      message: "Leaving the app may lose your staged files and finished output. Open the link anyway?",
      open: true,
      title: "Leave and lose work?",
    });

    latest().actions.onCancelConfirmation();
    await expect(confirmed).resolves.toBe(false);
  });

  it("lets an external navigation through when nothing is staged", async () => {
    await loadWebapp();

    await expect(latest().actions.onConfirmExternalNavigation()).resolves.toBe(true);
    expect(latest().confirmationDialog.open).toBe(false);
  });

  it("declines an outstanding confirmation when a second one opens", async () => {
    await loadWebapp();
    latest().actions.onPatcherInputsChange([{ name: "rom.sfc" }]);
    await flush();

    latest().actions.onReset();
    await flush();
    expect(latest().confirmationDialog.title).toBe("Reset the page?");

    const navigation = latest().actions.onConfirmExternalNavigation();
    await flush();
    expect(latest().confirmationDialog.title).toBe("Leave and lose work?");
    expect(mocks.resetRomWeaverRunner).not.toHaveBeenCalled();

    latest().actions.onCancelConfirmation();
    await expect(navigation).resolves.toBe(false);
  });
});

describe("settings actions", () => {
  it("closes the settings panel directly when the draft is unchanged", async () => {
    await loadWebapp();

    latest().actions.onOpenSettings();
    await flush();
    expect(latest().state.settingsDialogOpen).toBe(true);

    latest().actions.onCloseSettings();
    await flush();
    expect(latest().state.settingsDialogOpen).toBe(false);
    expect(latest().confirmationDialog.open).toBe(false);
  });

  it("asks before discarding an edited settings draft", async () => {
    await loadWebapp();
    const accent = otherOptionValue("accent");

    latest().actions.onOpenSettings();
    latest().actions.onDraftChange("accent", accent);
    await flush();
    expect(latest().state.draftSettings.accent).toBe(accent);

    latest().actions.onCloseSettings();
    await flush();
    expect(latest().confirmationDialog).toMatchObject({
      confirmLabel: "Discard changes",
      message: "You have unsaved settings changes. Close settings and discard them?",
      open: true,
      title: "Discard settings changes?",
    });

    latest().actions.onConfirmConfirmation();
    await flush();
    expect(latest().state.draftSettings.accent).toBe(getDefaultSettings().accent);
  });

  it("keeps the draft when the discard prompt is declined", async () => {
    await loadWebapp();
    const accent = otherOptionValue("accent");

    latest().actions.onOpenSettings();
    latest().actions.onDraftChange("accent", accent);
    await flush();
    latest().actions.onCloseSettings();
    await flush();
    latest().actions.onCancelConfirmation();
    await flush();

    expect(latest().state.draftSettings.accent).toBe(accent);
  });

  it("commits accent, language, log level, and bundle package changes", async () => {
    await loadWebapp();
    const accent = otherOptionValue("accent");
    const language = otherOptionValue("language");
    const logLevel = otherOptionValue("logLevel");
    const bundlePackage = otherOptionValue("bundlePackage");

    latest().actions.onAccentChange(accent);
    latest().actions.onLanguageChange(language);
    latest().actions.onLogLevelChange(logLevel);
    latest().actions.onPatcherBundlePackageChange(bundlePackage);
    await flush();

    expect(latest().state.settings).toMatchObject({ accent, bundlePackage, language, logLevel });
  });

  it("focuses the first invalid field when the draft cannot be saved", async () => {
    await loadWebapp();

    latest().actions.onDraftChange("threads", "not-a-number");
    latest().actions.onSaveClose();
    await flush();

    const invalidFieldId = latest().state.validation.invalidFields[0];
    expect(invalidFieldId).toBeTruthy();

    const field = document.createElement("input");
    field.id = String(invalidFieldId);
    document.body.append(field);
    latest().actions.onSaveClose();
    await flush();

    expect(document.activeElement?.id).toBe(invalidFieldId);
    expect(latest().state.settingsDialogOpen).toBe(false);
  });

  it("stages the defaults and saves a valid draft", async () => {
    await loadWebapp();

    latest().actions.onOpenSettings();
    latest().actions.onDraftChange("accent", otherOptionValue("accent"));
    latest().actions.onRestoreDefaults();
    await flush();
    expect(latest().state.draftSettings.accent).toBe(getDefaultSettings().accent);

    latest().actions.onSaveClose();
    await flush();
    expect(latest().state.settingsDialogOpen).toBe(false);
  });

  it("reloads the persisted settings when another tab writes them", async () => {
    await loadWebapp();
    const accent = otherOptionValue("accent");
    const stored = localStorage.getItem(LOCAL_STORAGE_SETTINGS_ID);

    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    await flush();
    expect(latest().state.settings.accent).toBe(getDefaultSettings().accent);

    latest().actions.onAccentChange(accent);
    await flush();
    expect(latest().state.settings.accent).toBe(accent);

    if (stored === null) localStorage.removeItem(LOCAL_STORAGE_SETTINGS_ID);
    else localStorage.setItem(LOCAL_STORAGE_SETTINGS_ID, stored);
    window.dispatchEvent(new StorageEvent("storage", { key: LOCAL_STORAGE_SETTINGS_ID, storageArea: localStorage }));
    await flush();

    expect(latest().state.settings.accent).toBe(getDefaultSettings().accent);
  });

  it("turns onboarding off when the beacon is dismissed", async () => {
    await loadWebapp();

    window.dispatchEvent(new CustomEvent("rom-weaver:onboarding-dismiss"));
    await flush();

    expect(latest().state.settings.onboardingEnabled).toBe(false);
  });
});

describe("session actions", () => {
  it("tracks the creator, patcher, trim, and ppf-undo sessions", async () => {
    await loadWebapp();

    latest().actions.onCreatorModifiedChange({ name: "modified.sfc" });
    latest().actions.onCreatorOriginalChange({ name: "original.sfc" });
    latest().actions.onCreatorPatchTypeChange("ips");
    latest().actions.onCreatorSettingsChange({ outputName: "patch.ips" });
    latest().actions.onPatcherPatchesChange([{}, {}]);
    latest().actions.onPatcherSettingsChange({ outputName: "out.sfc", outputCompression: "zip" });
    latest().actions.onPpfUndoSessionChange(true);
    latest().actions.onTrimOutputFormatChange("iso");
    latest().actions.onTrimSettingsChange({ outputName: "trimmed.iso" });
    latest().actions.onTrimSourceChange({ name: "disc.iso" });
    await flush();

    expect(latest().state.creatorSession).toMatchObject({
      modifiedFilePresent: true,
      originalFilePresent: true,
      patchType: "ips",
    });
    expect(latest().state.patcherSession.patchCount).toBe(2);
    expect(latest().state.ppfUndoSession.active).toBe(true);
    expect(latest().state.trimSession).toMatchObject({ outputFormat: "iso", sourceFilePresent: true });
  });

  it("warns before unload only once work is staged", async () => {
    await loadWebapp();
    const guarded = new Event("beforeunload", { cancelable: true });

    expect(window.dispatchEvent(guarded)).toBe(true);

    latest().actions.onPatcherInputsChange([{ name: "rom.sfc" }]);
    await flush();
    const blocked = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(blocked)).toBe(false);
  });
});

describe("page reset", () => {
  it("resets the runner, the controller, and the transient OPFS after confirmation", async () => {
    await loadWebapp();
    latest().actions.onPatcherInputsChange([{ name: "rom.sfc" }]);
    await flush();

    latest().actions.onReset();
    await flush();
    expect(latest().confirmationDialog).toMatchObject({
      confirmLabel: "Reset page",
      message: "Resetting will clear the current page state. Continue?",
      open: true,
    });

    latest().actions.onConfirmConfirmation();
    await flush();

    expect(mocks.resetRomWeaverRunner).toHaveBeenCalledWith({ terminate: true });
    expect(mocks.resetBrowserTransientOpfs).toHaveBeenCalledTimes(1);
    expect(latest().state.patcherSession.romFilePresent).toBe(false);
    expect(latest().urlSession).toBeNull();
  });

  it("does nothing when the reset prompt is declined", async () => {
    await loadWebapp();

    latest().actions.onReset();
    await flush();
    latest().actions.onCancelConfirmation();
    await flush();

    expect(mocks.resetRomWeaverRunner).not.toHaveBeenCalled();
  });

  it("logs a failed transient OPFS reset", async () => {
    mocks.resetBrowserTransientOpfs.mockRejectedValue(new Error("opfs locked"));
    await loadWebapp();

    latest().actions.onReset();
    await flush();
    latest().actions.onConfirmConfirmation();
    await flush();

    expect(consoleText()).toContain("Reset OPFS cleanup failed");
  });
});

describe("routing", () => {
  it("selects a view and asks the creator gate first", async () => {
    await loadWebapp();

    latest().actions.onSelectView("creator");
    await flush();

    expect(latest().state.currentView).toBe("creator");
    expect(window.location.pathname).toBe("/create");
  });

  it("starts a guided sample on its own view", async () => {
    await loadWebapp();
    const started: string[] = [];
    window.addEventListener(GUIDED_SAMPLE_START_EVENT, (event) => {
      started.push(String((event as CustomEvent<string>).detail));
    });

    latest().actions.onStartGuide("create");
    await flush();

    expect(latest().state.currentView).toBe("creator");
    expect(window.location.search).toBe("?guide=create");
    expect(started).toEqual(["create"]);
  });

  it("soft-navigates a same-origin workflow link and scrolls to the top", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    await loadWebapp();

    clickAnchor("/create");
    await flush();
    await nextFrame();

    expect(latest().state.currentView).toBe("creator");
    expect(window.location.pathname).toBe("/create");
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", left: 0, top: 0 });
  });

  it("scrolls to the anchor when one docs page links to another", async () => {
    await loadWebapp({ url: "/docs/getting-started" });
    const target = document.createElement("h2");
    target.id = "install";
    document.body.append(target);
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    clickAnchor("/docs/cli#install");
    await flush();

    expect(window.location.pathname).toBe("/docs/cli");
    expect(latest().state.currentView).toBe("docs");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("ignores a link that leaves the workflow routes", async () => {
    await loadWebapp();

    const anchor = clickAnchor("/not-a-route");
    await flush();

    expect(window.location.pathname).toBe("/apply");
    expect(anchor.isConnected).toBe(true);
  });

  it("follows back and forward navigation", async () => {
    await loadWebapp();

    window.history.pushState({}, "", "/create");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await flush();

    expect(latest().state.currentView).toBe("creator");
  });

  it("rewrites the address bar when the requested view is unavailable", async () => {
    await loadWebapp();

    window.history.pushState({}, "", "/trim");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await flush();

    expect(latest().state.currentView).toBe("patcher");
    expect(window.location.pathname).toBe("/apply");
  });

  it("starts the guide named in the address bar after a navigation", async () => {
    await loadWebapp();
    const started: string[] = [];
    window.addEventListener(GUIDED_SAMPLE_START_EVENT, (event) => {
      started.push(String((event as CustomEvent<string>).detail));
    });

    window.history.pushState({}, "", "/apply?guide=bundle");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await flush();

    expect(started).toEqual(["bundle"]);
  });

  it("does not soft-navigate from the not-found document", async () => {
    await loadWebapp({ notFound: true, url: "/nope" });

    clickAnchor("/create");
    await flush();

    expect(window.location.pathname).toBe("/nope");
  });
});
