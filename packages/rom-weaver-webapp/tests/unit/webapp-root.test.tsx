// @vitest-environment happy-dom
import { CHANNEL_BADGE } from "../../src/webapp/build-channel.ts";
import { withChannelBadge } from "../../src/webapp/workflow-seo.mjs";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadCatalog } from "../../src/presentation/localization/index.ts";
import { createEmptyVitePageUpdateState, getPageUpdateState } from "../../src/webapp/page-update-state.ts";
import { createServiceWorkerCacheState } from "../../src/webapp/pwa/service-worker-cache-state.ts";
import { createWebappRootController } from "../../src/webapp/webapp-controller.ts";
import { createEmptyConfirmationDialogState } from "../../src/webapp/webapp-root-types.ts";
import type { WebappRootProps } from "../../src/webapp/webapp-root-types.ts";
import { resolveThreads, selectViewWithTransition, WebappRoot } from "../../src/webapp/webapp-root.tsx";
import { preloadWorkflowRoute } from "../../src/webapp/workflow-routes.tsx";

const mocks = vi.hoisted(() => ({
  queryOfflineReadyState: vi.fn(async () => null),
  requestEmulatorStartFromUserAction: vi.fn(),
  scheduleOfflineWarmup: vi.fn(() => () => undefined),
}));

vi.mock("../../src/public/react/emulator-audio-context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/public/react/emulator-audio-context.ts")>()),
  requestEmulatorStartFromUserAction: mocks.requestEmulatorStartFromUserAction,
}));

vi.mock("../../src/webapp/pwa/offline-warmup-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/webapp/pwa/offline-warmup-client.ts")>();
  return {
    ...actual,
    queryOfflineReadyState: mocks.queryOfflineReadyState,
    scheduleOfflineWarmup: mocks.scheduleOfflineWarmup,
  };
});

// Stub the network-backed changelog so this suite can focus on route and dialog state.
vi.mock("../../src/webapp/components/changelog-panel.tsx", () => ({ ChangelogPanel: () => null }));

const noop = () => undefined;

type Actions = WebappRootProps["actions"];

const createActions = () => {
  const calls = new Map<string, ReturnType<typeof vi.fn>>();
  const actions = new Proxy({} as Record<string, unknown>, {
    get: (_target, property: string) => {
      if (property === "onConfirmExternalNavigation") return async () => true;
      let handler = calls.get(property);
      if (!handler) {
        handler = vi.fn();
        calls.set(property, handler);
      }
      return handler;
    },
  }) as unknown as Actions;
  const called = (name: string) => {
    let handler = calls.get(name);
    if (!handler) {
      handler = vi.fn();
      calls.set(name, handler);
    }
    return handler;
  };
  return { actions, called };
};

const baseState = () => {
  const controller = createWebappRootController({
    onApplySettings: noop,
    onCreatorViewRequested: () => true,
    onFocusField: noop,
    onLocalizationChange: noop,
    storage: undefined,
  });
  return { ...controller.getState(), startup: { message: "", status: "ready" as const } };
};

const renderRoot = async ({
  currentView = "patcher" as WebappRootProps["state"]["currentView"],
  assetBaseUrl,
  notFound = false,
  serviceWorkerStatus = null as WebappRootProps["serviceWorkerCache"]["serviceWorkerStatus"],
  settingsDialogOpen = false,
  language,
  updateReady = false,
}: {
  currentView?: WebappRootProps["state"]["currentView"];
  assetBaseUrl?: string;
  notFound?: boolean;
  serviceWorkerStatus?: WebappRootProps["serviceWorkerCache"]["serviceWorkerStatus"];
  settingsDialogOpen?: boolean;
  language?: string;
  updateReady?: boolean;
} = {}) => {
  if (!notFound) await preloadWorkflowRoute(currentView);
  const { actions, called } = createActions();
  const state = baseState();
  if (language) state.settings.language = language;
  const view = render(
    <WebappRoot
      actions={actions}
      assetBaseUrl={assetBaseUrl}
      confirmationDialog={createEmptyConfirmationDialogState()}
      notFound={notFound}
      pageUpdate={getPageUpdateState({
        serviceWorkerCache: { updateReady },
        vite: createEmptyVitePageUpdateState(),
      })}
      serviceWorkerCache={{ ...createServiceWorkerCacheState(), serviceWorkerStatus, updateReady }}
      state={{ ...state, currentView, settingsDialogOpen }}
      urlSession={null}
    />,
  );
  return { ...view, called };
};

const fileDragEvent = (type: string, target: EventTarget = document, files: File[] = []) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      dropEffect: "none",
      files,
      items: files.map((file) => ({ getAsFile: () => file, kind: "file" })),
      types: ["Files"],
    },
  });
  Object.defineProperty(event, "target", { value: target });
  return event;
};

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A nav row by its visible label, from whichever layout the test names. */
const navRow = (container: HTMLElement, name: string, scope = ".side-nav") =>
  Array.from(container.querySelectorAll<HTMLElement>(`${scope} .nav-row, ${scope} .guide-nav a`)).find(
    (row) => (row.querySelector(".nav-row-label")?.firstChild?.textContent ?? row.textContent)?.trim() === name,
  ) as HTMLElement;

describe("resolveThreads", () => {
  it("keeps an explicit count and falls back for anything unusable", () => {
    expect(resolveThreads(6)).toBe(6);
    expect(resolveThreads("6")).toBe(6);
    expect(resolveThreads("auto")).toBeGreaterThanOrEqual(1);
    expect(resolveThreads(0)).toBeGreaterThanOrEqual(1);
    expect(resolveThreads(undefined)).toBeGreaterThanOrEqual(1);
  });
});

describe("selectViewWithTransition", () => {
  it("runs the selection", () => {
    const select = vi.fn();
    selectViewWithTransition(select);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe("the workbench shell", () => {
  it.each(["patcher", "home", "docs"] as const)("shows one shared legal footer on %s", async (currentView) => {
    const { container } = await renderRoot({ currentView });
    const footers = container.querySelectorAll("footer.page-footer");
    expect(footers).toHaveLength(1);
    expect(footers[0]?.textContent).toBe("On-device. Offline support. No telemetry.AboutPrivacy");
    expect(footers[0]?.querySelector('a[href="/docs/about"]')?.textContent).toBe("About");
    expect(footers[0]?.querySelector('a[href="/docs/privacy"]')?.textContent).toBe("Privacy");
    expect(footers[0]?.querySelector(".page-footer-links")?.className).toBe("page-footer-links");
    expect(footers[0]?.querySelectorAll(".page-footer-link")).toHaveLength(2);
    expect(container.querySelector("main footer.page-footer")).toBeNull();
    expect(container.querySelector(".hero-privacy")).toBeNull();
  });

  it("mounts the requested workflow panel and names the page for it", async () => {
    const { container } = await renderRoot();

    expect(container.querySelector("#panel-patcher")).not.toBeNull();
    expect(container.querySelector("#panel-patcher")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector("#panel-creator")).toBeNull();
    expect(document.title).toContain("rom-weaver");
    expect(document.documentElement.dataset.betaToolsEnabled).toBeDefined();
  });

  it.each(["de", "es", "en"])("marks the document language as %s once the locale is active", async (language) => {
    document.documentElement.lang = "en";
    await renderRoot({ language });

    expect(document.documentElement.lang).toBe(language);
  });

  it("names the Save Editor row and page title in full, not Saves", async () => {
    const { container } = await renderRoot({ currentView: "save-editor" });

    expect(navRow(container, "Save Editor")).toBeTruthy();
    expect(navRow(container, "Saves")).toBeUndefined();
    expect(document.title).toContain("Save Editor");
  });

  it("renders the not-found workbench with links out and no workflow panels", async () => {
    const { container } = await renderRoot({ notFound: true });

    expect(container.querySelector(".not-found-page")).not.toBeNull();
    expect(container.querySelector("footer.page-footer")).not.toBeNull();
    expect(container.querySelector(".not-found-home")?.getAttribute("href")).toBe("/apply-patches");
    expect(container.querySelector("#panel-patcher")).toBeNull();
    expect(container.querySelector(".workbench")?.className).toContain("is-not-found");
  });

  it("renders the not-found page in the browser locale", async () => {
    const languages = vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de"]);
    await preloadCatalog("de");
    try {
      const { container } = await renderRoot({ notFound: true });

      expect(container.querySelector("#not-found-title")?.getAttribute("aria-label")).toBe("404: Seite nicht gefunden");
      expect(container.querySelector(".not-found-docs")?.textContent).toBe("Dokumentation durchsuchen");
    } finally {
      languages.mockRestore();
    }
  });

  it("renders the not-found page in the saved language instead of the browser locale", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en"]);
    await preloadCatalog("de");
    const { container } = await renderRoot({ notFound: true, language: "de" });

    expect(container.querySelector("#not-found-title")?.getAttribute("aria-label")).toBe("404: Seite nicht gefunden");
    expect(container.querySelector(".not-found-label")?.textContent).toBe("Diese Seite gibt es hier nicht.");
    expect(container.querySelector(".not-found-copy")?.textContent).toBe(
      "Prüfe die Adresse oder wähle, wohin du als Nächstes möchtest.",
    );
    expect(container.querySelector(".not-found-docs")?.textContent).toBe("Dokumentation durchsuchen");
  });

  it("keeps not-found links and tab loads inside a subdirectory deployment", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const { container } = await renderRoot({ assetBaseUrl: "https://example.test/rom-weaver/", notFound: true });

    expect(container.querySelector(".not-found-home")?.getAttribute("href")).toBe("/rom-weaver/apply-patches");
    expect(container.querySelector(".not-found-docs")?.getAttribute("href")).toBe("/rom-weaver/docs");
    const tabHrefs = [...container.querySelectorAll(".side-nav a[href^='/']")].map((link) => link.getAttribute("href"));
    expect(tabHrefs).toContain("/rom-weaver/docs");
    expect(tabHrefs.filter((href) => !href?.startsWith("/rom-weaver/"))).toEqual([]);

    fireEvent.click(container.querySelector('.dock-tab[data-mode="creator"]') as HTMLAnchorElement);
    expect(assign).toHaveBeenCalledWith("/rom-weaver/create-patch");
    fireEvent.click(navRow(container, "Docs"));
    expect(assign).toHaveBeenCalledWith("/rom-weaver/docs");
  });

  it("renders the not-found page in the browser locale", async () => {
    const languages = vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de"]);
    await preloadCatalog("de");
    try {
      const { container } = await renderRoot({ notFound: true });

      expect(container.querySelector("#not-found-title")?.getAttribute("aria-label")).toBe("404: Seite nicht gefunden");
      expect(container.querySelector(".not-found-docs")?.textContent).toBe("Dokumentation durchsuchen");
    } finally {
      languages.mockRestore();
    }
  });

  it("routes a not-found tab click to a full page load", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const { container } = await renderRoot({ notFound: true });

    fireEvent.click(container.querySelector('.dock-tab[data-mode="creator"]') as HTMLAnchorElement);

    expect(assign).toHaveBeenCalledWith("/create-patch");
  });

  it("keeps the not-found Docs link on the site root instead of a protocol-relative URL", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const { container } = await renderRoot({ notFound: true });

    const hrefs = [...container.querySelectorAll("a[href]")].map((link) => link.getAttribute("href"));
    expect(hrefs.filter((href) => href?.startsWith("//"))).toEqual([]);
    expect(hrefs).toContain("/docs");

    fireEvent.click(navRow(container, "Docs"));

    expect(assign).toHaveBeenCalledWith("/docs");
  });
});

describe("tab selection", () => {
  it("asks the host to change view", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector('.dock-tab[data-mode="creator"]') as HTMLAnchorElement);

    expect(called("onSelectView")).toHaveBeenCalledWith("creator");
  });

  it("starts the emulator audio context from the Test tab's own click", async () => {
    const { container } = await renderRoot();

    fireEvent.click(container.querySelector('.dock-tab[data-mode="test"]') as HTMLAnchorElement);

    expect(mocks.requestEmulatorStartFromUserAction).toHaveBeenCalledTimes(1);
  });

  it("waits for the lazy Docs route before switching to it", async () => {
    const { called, container } = await renderRoot();

    // Docs MUST stay outside the dock's three workflow slots.
    expect(container.querySelector('.dock-tab[data-mode="docs"]')).toBeNull();
    expect(container.querySelector(".guide-nav")).toBeNull();
    const docs = navRow(container, "Docs");
    expect(docs.closest(".nav-group")?.querySelector(".nav-group-label")?.textContent).toBe("Project");
    fireEvent.click(docs);
    expect(called("onSelectView")).not.toHaveBeenCalled();
    expect(container.querySelector('.side-nav #tab-patcher[aria-current="page"]')).not.toBeNull();
    expect(container.querySelector(".guide-nav")).toBeNull();

    await waitFor(() => expect(called("onSelectView")).toHaveBeenCalledWith("docs"));
  });
});

describe("the unified dialog", () => {
  const openFromMore = (container: HTMLElement, name: string) => {
    fireEvent.click(navRow(container, name));
  };

  it("opens on Offline app from the sidebar", async () => {
    const { container } = await renderRoot();

    openFromMore(container, "Offline app");

    await waitFor(() => expect(container.querySelector("dialog.log-dlg")).not.toBeNull());
    expect(container.querySelector('[data-logtab="offline"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens on Offline app while an update is waiting", async () => {
    const { container } = await renderRoot({ updateReady: true });

    openFromMore(container, "Offline app");

    await waitFor(() => expect(container.querySelector("dialog.log-dlg")).not.toBeNull());
    expect(container.querySelector('[data-logtab="offline"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens on Storage and on Logs", async () => {
    const { container } = await renderRoot();

    openFromMore(container, "Saves & storage");
    await waitFor(() =>
      expect(container.querySelector('[data-logtab="storage"]')?.getAttribute("aria-selected")).toBe("true"),
    );

    openFromMore(container, "Logs");
    await waitFor(() =>
      expect(container.querySelector('[data-logtab="logs"]')?.getAttribute("aria-selected")).toBe("true"),
    );
  });

  it("switches from the default simple view to detailed view from the panel heading", async () => {
    const { called, container } = await renderRoot();

    const toggle = container.querySelector(".workflow-panel-head .panel-view-toggle input") as HTMLInputElement;
    expect(toggle.closest("label")?.textContent).toBe("Detailed");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute("aria-label")).toBe("Detailed");
    fireEvent.click(toggle);

    expect(called("onDetailedViewEnabledChange")).toHaveBeenCalledWith(true);
    expect(called("onOpenSettings")).not.toHaveBeenCalled();
  });

  it.each(["patcher", "creator", "trim"] as const)(
    "shows the thread setting beside the view toggle on %s",
    async (view) => {
      const { container } = await renderRoot({ currentView: view });
      const button = container.querySelector(`#panel-${view} .panel-threads-btn`) as HTMLButtonElement | null;
      expect(button?.textContent).toMatch(/^\d+ threads?$/);
      expect(container.querySelector(".masthead-threads")).toBeNull();
    },
  );

  it.each(["identify", "test", "ppf-undo", "save-editor"] as const)(
    "does not show the thread setting on %s",
    async (view) => {
      const { container } = await renderRoot({ currentView: view });
      expect(container.querySelector(`#panel-${view} .panel-threads-btn`)).toBeNull();
    },
  );

  it("resets the workflow from the panel head", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector(".workflow-panel-head .reset-btn") as HTMLButtonElement);

    expect(called("onReset")).toHaveBeenCalledTimes(1);
  });
});

describe("the update banner", () => {
  it("remembers a dismissal for this build", async () => {
    const { container } = await renderRoot({ updateReady: true });
    const banner = container.querySelector(".reveal.is-open .updates.update-ready");
    expect(banner).not.toBeNull();

    fireEvent.click(container.querySelector(".updates.update-ready .banner-x") as HTMLButtonElement);

    expect(container.querySelector(".reveal.is-open .updates.update-ready")).toBeNull();
    expect(window.localStorage.getItem("rom-weaver-update-dismissed-build")).toBeTruthy();
  });

  it("stays dismissed on the next mount of the same build", async () => {
    const first = await renderRoot({ updateReady: true });
    fireEvent.click(first.container.querySelector(".updates.update-ready .banner-x") as HTMLButtonElement);
    cleanup();

    const second = await renderRoot({ updateReady: true });

    expect(second.container.querySelector(".reveal.is-open .updates.update-ready")).toBeNull();
  });

  it("sends its What's new link to the whats-new route", async () => {
    const { called, container } = await renderRoot({ updateReady: true });

    fireEvent.click(container.querySelector(".updates.update-ready .updates-ver") as HTMLButtonElement);

    await waitFor(() => expect(called("onSelectView")).toHaveBeenCalledWith("whats-new"));
  });
});

describe("the What's new route", () => {
  it("mounts the changelog panel with no panel-head gear", async () => {
    const { container } = await renderRoot({ currentView: "whats-new" });

    const panel = container.querySelector("#panel-whats-new");
    expect(panel).not.toBeNull();
    expect(panel?.hasAttribute("hidden")).toBe(false);
    expect(panel?.querySelector(".workflow-panel-head")).toBeNull();
    expect(document.title).toBe(withChannelBadge("What's new | rom-weaver", CHANNEL_BADGE));
  });

  it("reaches the route from the version chip", async () => {
    const { called, container } = await renderRoot();

    // A dev/nightly checkout wears the channel badge instead of the plain
    // version chip; either button opens What's new.
    fireEvent.click(container.querySelector(".build-tag button") as HTMLButtonElement);

    await waitFor(() => expect(called("onSelectView")).toHaveBeenCalledWith("whats-new"));
  });

  it("reaches the route from the nav's Project group", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(navRow(container, "What’s new"));

    await waitFor(() => expect(called("onSelectView")).toHaveBeenCalledWith("whats-new"));
  });
});

describe("page-level drag and drop", () => {
  it.each([
    { currentView: "docs" as const },
    { currentView: "whats-new" as const },
    { currentView: "save-editor" as const },
    { currentView: "patcher" as const, notFound: true },
  ])("offers ROM routing from $currentView (notFound=$notFound)", async (options) => {
    const { called, container } = await renderRoot(options);
    const drag = fileDragEvent("dragover");
    act(() => {
      document.dispatchEvent(drag);
    });
    expect(drag.defaultPrevented).toBe(true);
    expect(container.querySelector("#column")?.className).toContain("rw-page-dragging");
    expect(container.querySelector(".dropveil-text")?.textContent).toBe("Release to add files");

    const drop = fileDragEvent("drop", document.body, [new File(["rom"], "game.sfc")]);
    act(() => {
      document.dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true);
    await waitFor(() => expect(within(container).queryByRole("button", { name: /Test ROM/ })).toBeTruthy());
    expect(called("onSelectView")).not.toHaveBeenCalled();
    fireEvent.click(within(container).getByRole("button", { name: /Apply Patches/ }));
    await waitFor(() => expect(called("onSelectView")).toHaveBeenCalledWith("patcher"));
    expect(container.querySelector(".is-not-found")).toBeNull();
  });

  it("arms the page while a file is dragged over it", async () => {
    const { container } = await renderRoot();

    act(() => {
      document.dispatchEvent(fileDragEvent("dragover"));
    });

    expect(container.querySelector("#column")?.className).toContain("rw-page-dragging");
  });

  it("ignores a drag that carries no files", async () => {
    const { container } = await renderRoot();
    const event = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { items: [], types: ["text/plain"] } });

    act(() => {
      document.dispatchEvent(event);
    });

    expect(container.querySelector("#column")?.className).not.toContain("rw-page-dragging");
  });

  it("claims a page drop and clears the armed state", async () => {
    const { container } = await renderRoot();
    const dropped = fileDragEvent("drop", document.body, [new File(["rom"], "game.sfc")]);

    act(() => {
      document.dispatchEvent(fileDragEvent("dragover"));
      document.dispatchEvent(dropped);
    });

    expect(dropped.defaultPrevented).toBe(true);
    await waitFor(() => expect(container.querySelector("#column")?.className).not.toContain("rw-page-dragging"));
  });

  it("leaves a drop inside a workflow drop zone to that zone", async () => {
    const { container } = await renderRoot();
    const zone = container.querySelector(".rw-app .drop");
    if (!zone) throw new Error("The apply workflow rendered no drop zone");
    const dropped = fileDragEvent("drop", zone, [new File(["rom"], "game.sfc")]);

    act(() => {
      document.dispatchEvent(dropped);
    });

    expect(dropped.defaultPrevented).toBe(false);
  });

  it("names the workflow a landing-page drop opens, then lets the veil go", async () => {
    const { called, container } = await renderRoot({ currentView: "home" });
    const column = () => container.querySelector("#column")?.className ?? "";

    act(() => {
      document.dispatchEvent(fileDragEvent("drop", document.body, [new File(["patch"], "hack.bps")]));
    });

    await waitFor(() => expect(called("onSelectView")).toHaveBeenCalledWith("patcher"));
    expect(column()).toContain("rw-drop-routing");
    expect(container.querySelector(".dropveil-text")?.textContent).toBe("Opening Apply Patches");
    expect(container.querySelector('p[role="status"].sr-only')?.textContent).toBe("Opening Apply Patches");
    await waitFor(() => expect(column()).not.toContain("rw-drop-routing"), { timeout: 2000 });
  });

  it("routes a file picked on the landing page without raising the drop veil", async () => {
    const { called, container } = await renderRoot({ currentView: "home" });
    const input = container.querySelector<HTMLInputElement>("#home-file-input");
    if (!input) throw new Error("The landing page rendered no file input");
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(container.querySelector("#column")?.className ?? ""));
    observer.observe(container.querySelector("#column") as Element, { attributeFilter: ["class"] });

    Object.defineProperty(input, "files", { value: [new File(["patch"], "hack.bps")] });
    fireEvent.change(input);

    await waitFor(() => expect(called("onSelectView")).toHaveBeenCalledWith("patcher"));
    observer.disconnect();
    expect(seen.some((className) => className.includes("rw-drop-routing"))).toBe(false);
  });

  it("lets the veil go without naming a workflow when a landing-page drop needs a choice", async () => {
    const { called, container } = await renderRoot({ currentView: "home" });

    act(() => {
      document.dispatchEvent(fileDragEvent("drop", document.body, [new File(["rom"], "game.sfc")]));
    });

    await waitFor(() => expect(container.querySelector("#column")?.className).not.toContain("rw-drop-routing"));
    expect(called("onSelectView")).not.toHaveBeenCalled();
    expect(container.querySelector(".dropveil-text")?.textContent).not.toContain("Opening");
  });
});

describe("page metadata per view", () => {
  it("updates PPF undo metadata after navigating from Apply", async () => {
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    const description = document.createElement("meta");
    description.name = "description";
    document.head.append(canonical, description);
    try {
      const root = await renderRoot({ currentView: "patcher" });
      expect(canonical.href).toBe("https://rom-weaver.com/apply-patches");
      root.unmount();
      await renderRoot({ currentView: "ppf-undo" });
      expect(canonical.href).toBe("https://rom-weaver.com/ppf-undo");
      expect(description.content).toContain("Undo a PPF3 patch");
      expect(document.title).toContain("Undo PPF patches online");
    } finally {
      canonical.remove();
      description.remove();
    }
  });

  it("names the page for a view that has no SEO route of its own", async () => {
    await renderRoot({ currentView: "trim" });

    expect(document.title).toBe(withChannelBadge("Trim ROM | rom-weaver", CHANNEL_BADGE));
  });

  it("uses the marketing title for a view that has one", async () => {
    await renderRoot({ currentView: "test" });

    expect(document.title).not.toBe("Test | rom-weaver");
    expect(document.title).toContain("rom-weaver");
  });
});

describe("entry animations", () => {
  it("locks an entry animation once it has played", async () => {
    const { container } = await renderRoot();
    const panel = container.querySelector("#panel-patcher") as HTMLElement;

    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", { value: "card-in" });
      panel.dispatchEvent(event);
    });

    expect(panel.style.animation).toBe("none");
  });

  it("leaves an animation it does not own alone", async () => {
    const { container } = await renderRoot();
    const panel = container.querySelector("#panel-patcher") as HTMLElement;

    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", { value: "spin" });
      panel.dispatchEvent(event);
    });

    expect(panel.style.animation).toBe("");
  });
});

describe("offline warm-up progress", () => {
  it.each([false, true])("shows offline progress and saves readiness with notFound=%s", async (notFound) => {
    const { container } = await renderRoot({ notFound, serviceWorkerStatus: "active" });
    const onProgress = mocks.scheduleOfflineWarmup.mock.calls.at(-1)?.[0]?.onProgress;
    if (!onProgress) throw new Error("The root scheduled no warm-up");

    act(() => {
      onProgress({ cachedBytes: 1, ready: true, totalBytes: 1 });
    });

    await waitFor(() => expect(container.querySelector(".sub-status")?.getAttribute("data-sw")).toBe("active"));
    expect(window.localStorage.getItem("rom-weaver-offline-ready")).toBe("true");
  });
});

describe("the settings draft flow", () => {
  const openSettings = (container: HTMLElement) => {
    fireEvent.click(navRow(container, "Settings"));
    return waitFor(() => {
      const dialog = container.querySelector("dialog.log-dlg");
      if (!dialog) throw new Error("The settings dialog never opened");
      return dialog as HTMLDialogElement;
    });
  };

  it("re-stages the draft when the dialog's own Settings tab is chosen", async () => {
    const { called, container } = await renderRoot({ settingsDialogOpen: true });
    await openSettings(container);
    const before = called("onOpenSettings").mock.calls.length;

    fireEvent.click(container.querySelector('[data-logtab="logs"]') as HTMLButtonElement);
    fireEvent.click(container.querySelector('[data-logtab="settings"]') as HTMLButtonElement);

    expect(called("onOpenSettings").mock.calls.length).toBe(before + 1);
  });

  it("runs the discard flow instead of closing the dialog outright", async () => {
    const { called, container } = await renderRoot({ settingsDialogOpen: true });
    const dialog = await openSettings(container);

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(called("onCloseSettings")).toHaveBeenCalledTimes(1);
    // The dialog stays up until the controller actually clears the draft.
    expect(container.querySelector("dialog.log-dlg")).not.toBeNull();
  });

  it("closes the dialog straight away when no draft is staged", async () => {
    const { called, container } = await renderRoot();
    fireEvent.click(navRow(container, "Offline app"));
    const dialog = await waitFor(() => container.querySelector("dialog.log-dlg") as HTMLDialogElement);

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(called("onCloseSettings")).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector("dialog.log-dlg")).toBeNull());
  });

  it("saves the draft from the dialog's Save control", async () => {
    const { called, container } = await renderRoot({ settingsDialogOpen: true });
    await openSettings(container);

    const save = await waitFor(() => {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (entry) => entry.textContent?.trim() === "Save",
      );
      if (!button) throw new Error("The settings tab rendered no Save control");
      return button;
    });
    fireEvent.click(save);

    expect(called("onSaveClose")).toHaveBeenCalledTimes(1);
  });

  it("deep links the page thread count into the Threads setting", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector("#panel-patcher .panel-threads-btn") as HTMLButtonElement);

    expect(called("onOpenSettings")).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(container.querySelector('[data-logtab="settings"]')?.getAttribute("aria-selected")).toBe("true"),
    );
  });
});

describe("idle preloading", () => {
  it("warms the dialogs without the ROM runtime on a guide page", async () => {
    const idle = vi.fn();
    vi.stubGlobal("requestIdleCallback", idle);

    await renderRoot({ currentView: "docs" });

    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle.mock.calls[0]?.[1]).toEqual({ timeout: 2000 });
    const scheduled = idle.mock.calls[0]?.[0];
    if (!scheduled) throw new Error("requestIdleCallback must have been scheduled");
    act(() => {
      (scheduled as () => void)();
    });
    vi.unstubAllGlobals();
  });

  it("falls back to a timeout when the browser has no idle callback", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    await renderRoot({ currentView: "docs" });

    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 0)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("host ingest", () => {
  it("logs a path it cannot resolve instead of throwing", async () => {
    const { ingest } = await import("../../src/webapp/host-ingest.ts");
    await renderRoot();

    expect(() => ingest(["/work/rom-weaver-imports/missing.sfc"])).not.toThrow();
  });
});

describe("console history", () => {
  it("puts each section in history so Back walks through them and then closes", async () => {
    window.history.replaceState(null, "", "/");
    const { container } = await renderRoot();

    fireEvent.click(navRow(container, "Offline app"));
    await waitFor(() => expect(window.location.hash).toBe("#console-offline"));
    fireEvent.click(container.querySelector('[data-logtab="logs"]') as HTMLButtonElement);
    expect(window.location.hash).toBe("#console-logs");

    window.history.back();
    await waitFor(() =>
      expect(container.querySelector('[data-logtab="offline"]')?.getAttribute("aria-selected")).toBe("true"),
    );
    window.history.back();
    await waitFor(() => {
      expect(container.querySelector("dialog.log-dlg")).toBeNull();
      expect(window.location.hash).toBe("");
    });
  });

  it("drops its entries when the console closes from inside", async () => {
    window.history.replaceState(null, "", "/");
    const { container } = await renderRoot();
    const before = window.history.length;

    fireEvent.click(navRow(container, "Offline app"));
    fireEvent.click(container.querySelector('[data-logtab="about"]') as HTMLButtonElement);
    await waitFor(() => expect(window.location.hash).toBe("#console-about"));
    fireEvent.keyDown(container.querySelector("dialog.log-dlg") as HTMLDialogElement, { key: "Escape" });

    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(container.querySelector("dialog.log-dlg")).toBeNull();
    expect(window.history.length).toBe(before + 2);
  });
});

describe("the phone dock", () => {
  it("opens the settings console from Menu, and the console's own dock reads Close", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector(".dock-menu") as HTMLButtonElement);
    fireEvent.click(container.querySelector('#menu-sheet [data-nav="settings"]') as HTMLButtonElement);

    expect(called("onOpenSettings")).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(container.querySelector('[data-logtab="settings"]')?.getAttribute("aria-selected")).toBe("true"),
    );
    // The modal makes the page's dock inert, so the console repeats it with Menu reading Close.
    const consoleDock = container.querySelector(".log-dlg .dock") as HTMLElement;
    const slots = Array.from(consoleDock.querySelectorAll(".dock-tab")).map((slot) => slot.textContent);
    expect(slots).toEqual(["Apply", "Create", "Identify", "Test", "Close"]);
    fireEvent.click(consoleDock.querySelector(".dock-menu") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".log-dlg")).toBeNull());
  });
});

describe("development offline status", () => {
  it("forces every display state and restores the actual status", async () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("MODE", "development");
    window.history.replaceState(null, "", "/?offline-layout=title&offline-state=disabled");
    const { container, called } = await renderRoot({ settingsDialogOpen: true });
    fireEvent.click(navRow(container, "Settings"));
    fireEvent.click(container.querySelector('[data-logtab="offline"]') as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector("#dev-offline-state")).not.toBeNull());
    const select = container.querySelector("#dev-offline-state") as HTMLSelectElement;
    const actual = container.querySelector(".header-runtime .sub-status")?.getAttribute("data-sw");
    expect(select.value).toBe("actual");
    expect(container.querySelector(".header-runtime .sub-status")?.getAttribute("data-sw")).toBe(actual);
    for (const value of ["active", "ready", "update", "installing", "online", "disabled"]) {
      fireEvent.change(select, { target: { value } });
      expect(container.querySelector(".header-runtime .sub-status")?.getAttribute("data-sw")).toBe(value);
      expect(container.querySelector(".reveal.is-open .update-ready") !== null).toBe(value === "update");
      if (value === "update") {
        fireEvent.click(container.querySelector(".updates .banner-x") as HTMLButtonElement);
        expect(container.querySelector(".reveal.is-open .update-ready")).toBeNull();
        expect(window.localStorage.getItem("rom-weaver-update-dismissed-build")).toBeNull();
      }
    }
    fireEvent.change(select, { target: { value: "actual" } });
    expect(container.querySelector(".header-runtime .sub-status")?.getAttribute("data-sw")).toBe(actual);
    expect(window.location.search).toBe("?offline-layout=title&offline-state=disabled");
    expect(called("onOfflineCopyEnabledChange")).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('[data-logtab="offline"]') as HTMLButtonElement);
    fireEvent.click(navRow(container, "What’s new"));
    expect(called("onSelectView")).toHaveBeenCalledWith("whats-new");
  });

  it("hides overrides and ignores their URL parameters in production", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("MODE", "production");
    window.history.replaceState(null, "", "/?offline-layout=strip&offline-state=disabled");
    const { container } = await renderRoot({ settingsDialogOpen: true, updateReady: true });
    fireEvent.click(navRow(container, "Settings"));
    await waitFor(() => expect(container.querySelector(".settings-panel")).not.toBeNull());
    expect(container.querySelector("#dev-offline-state")).toBeNull();
    expect(container.querySelector(".header-runtime .sub-status")?.getAttribute("data-sw")).toBe("update");
  });
});

it("keeps a safety confirmation open when agent approval finishes", () => {
  const { actions, called } = createActions();
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const confirmationDialog = {
    ...createEmptyConfirmationDialogState(),
    open: true,
    title: "Reset page?",
    message: "Discard staged work?",
    confirmLabel: "Reset page",
  };
  const props = {
    actions,
    confirmationDialog,
    notFound: true,
    pageUpdate: getPageUpdateState({
      serviceWorkerCache: { updateReady: false },
      vite: createEmptyVitePageUpdateState(),
    }),
    serviceWorkerCache: createServiceWorkerCacheState(),
    state: baseState(),
  };
  const approval = {
    ...createEmptyConfirmationDialogState(),
    open: true,
    title: "Approve agent action?",
    confirmLabel: "Approve action",
  };
  const view = render(<WebappRoot {...props} />);
  view.rerender(<WebappRoot {...props} agentApprovalDialog={{ state: approval, onCancel, onConfirm }} />);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(called("onCancelConfirmation")).not.toHaveBeenCalled();
  fireEvent.click(view.getByText("Approve action"));
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(called("onCancelConfirmation")).not.toHaveBeenCalled();
  expect(called("onConfirmConfirmation")).not.toHaveBeenCalled();
  view.rerender(
    <WebappRoot {...props} agentApprovalDialog={{ state: { ...approval, open: false }, onCancel, onConfirm }} />,
  );
  fireEvent.click(view.getByText("Reset page"));
  expect(called("onConfirmConfirmation")).toHaveBeenCalledOnce();
});
